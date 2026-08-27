import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from 'ssh2';

export interface SftpTestServerHandle {
  server: Server;
  host: string;
  port: number;
  username: string;
  password: string;
  /** The real local directory backing the server's file tree - "/" on the SFTP side maps to this on disk. */
  root: string;
}

const OPEN_MODE = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 };
const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
};

function toRemoteRoot(root: string, remotePath: string): string {
  const relative = remotePath.replace(/^\/+/, '');
  return path.join(root, relative);
}

function toAttrs(stat: fs.Stats): { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number } {
  return {
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

function longname(name: string, isDir: boolean): string {
  return `${isDir ? 'd' : '-'}rwxr-xr-x 1 owner group 0 Jan 01 00:00 ${name}`;
}

/**
 * A real, minimal SFTP server for demoing SftpClient (imported from
 * referenced-automation-utils) against - a real implementation of the SFTP
 * protocol's OPEN/READ/WRITE/CLOSE/OPENDIR/READDIR/LSTAT/REALPATH/MKDIR/
 * RMDIR/REMOVE operations (via ssh2's own Server API), backed by a real
 * temp directory on disk. Same helper as referenced-automation-utils' own
 * tests/support/sftpTestServer.ts, duplicated here rather than shared since
 * it's test-only infra, not part of any published package.
 */
export async function startSftpTestServer(): Promise<SftpTestServerHandle> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-test-'));
  const username = 'testuser';
  const password = 'testpass';

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
          ctx.accept();
        } else {
          ctx.reject(['password']);
        }
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp() as any;
            const openFiles = new Map<number, { path: string; forWrite: boolean; chunks: { offset: number; data: Buffer }[]; readBuffer?: Buffer }>();
            const openDirs = new Map<number, { path: string; done: boolean }>();
            let nextHandle = 0;

            function allocHandle(): { id: number; buf: Buffer } {
              const id = nextHandle++;
              const buf = Buffer.alloc(4);
              buf.writeUInt32BE(id, 0);
              return { id, buf };
            }

            sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
              const resolved = toRemoteRoot(root, filename);
              const forWrite = (flags & OPEN_MODE.WRITE) !== 0;
              const { id, buf } = allocHandle();
              if (forWrite) {
                openFiles.set(id, { path: resolved, forWrite: true, chunks: [] });
              } else {
                if (!fs.existsSync(resolved)) {
                  return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                }
                openFiles.set(id, { path: resolved, forWrite: false, chunks: [], readBuffer: fs.readFileSync(resolved) });
              }
              sftp.handle(reqid, buf);
            });

            sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
              const entry = openFiles.get(handle.readUInt32BE(0));
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              entry.chunks.push({ offset, data: Buffer.from(data) });
              sftp.status(reqid, STATUS_CODE.OK);
            });

            sftp.on('READ', (reqid: number, handle: Buffer, offset: number, len: number) => {
              const entry = openFiles.get(handle.readUInt32BE(0));
              if (!entry || !entry.readBuffer) return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (offset >= entry.readBuffer.length) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, entry.readBuffer.subarray(offset, offset + len));
            });

            sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
              const id = handle.readUInt32BE(0);
              const file = openFiles.get(id);
              if (file) {
                if (file.forWrite) {
                  const total = file.chunks.reduce((max, c) => Math.max(max, c.offset + c.data.length), 0);
                  const out = Buffer.alloc(total);
                  for (const chunk of file.chunks) chunk.data.copy(out, chunk.offset);
                  fs.writeFileSync(file.path, out);
                }
                openFiles.delete(id);
              }
              openDirs.delete(id);
              sftp.status(reqid, STATUS_CODE.OK);
            });

            sftp.on('OPENDIR', (reqid: number, dirPath: string) => {
              const resolved = toRemoteRoot(root, dirPath);
              if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              }
              const { id, buf } = allocHandle();
              openDirs.set(id, { path: resolved, done: false });
              sftp.handle(reqid, buf);
            });

            sftp.on('READDIR', (reqid: number, handle: Buffer) => {
              const entry = openDirs.get(handle.readUInt32BE(0));
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              if (entry.done) return sftp.status(reqid, STATUS_CODE.EOF);
              entry.done = true;
              const names = fs.readdirSync(entry.path).map((name) => {
                const stat = fs.statSync(path.join(entry.path, name));
                return { filename: name, longname: longname(name, stat.isDirectory()), attrs: toAttrs(stat) };
              });
              sftp.name(reqid, names);
            });

            sftp.on('LSTAT', (reqid: number, filePath: string) => {
              const resolved = toRemoteRoot(root, filePath);
              if (!fs.existsSync(resolved)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              sftp.attrs(reqid, toAttrs(fs.lstatSync(resolved)));
            });

            sftp.on('STAT', (reqid: number, filePath: string) => {
              const resolved = toRemoteRoot(root, filePath);
              if (!fs.existsSync(resolved)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              sftp.attrs(reqid, toAttrs(fs.statSync(resolved)));
            });

            sftp.on('FSTAT', (reqid: number, handle: Buffer) => {
              const entry = openFiles.get(handle.readUInt32BE(0));
              if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
              sftp.attrs(reqid, toAttrs(fs.statSync(entry.path)));
            });

            sftp.on('REALPATH', (reqid: number, requestPath: string) => {
              const normalized = '/' + path.posix.normalize(requestPath).replace(/^\/+/, '');
              sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
            });

            sftp.on('MKDIR', (reqid: number, dirPath: string) => {
              const resolved = toRemoteRoot(root, dirPath);
              try {
                fs.mkdirSync(resolved, { recursive: true });
                sftp.status(reqid, STATUS_CODE.OK);
              } catch {
                sftp.status(reqid, STATUS_CODE.FAILURE);
              }
            });

            sftp.on('RMDIR', (reqid: number, dirPath: string) => {
              const resolved = toRemoteRoot(root, dirPath);
              try {
                fs.rmSync(resolved, { recursive: true, force: true });
                sftp.status(reqid, STATUS_CODE.OK);
              } catch {
                sftp.status(reqid, STATUS_CODE.FAILURE);
              }
            });

            sftp.on('REMOVE', (reqid: number, filePath: string) => {
              const resolved = toRemoteRoot(root, filePath);
              try {
                fs.unlinkSync(resolved);
                sftp.status(reqid, STATUS_CODE.OK);
              } catch {
                sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
              }
            });
          });
        });
      });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', function (this: { address(): { port: number } }) {
      resolve(this.address().port);
    });
  });

  return { server, host: '127.0.0.1', port, username, password, root };
}

export async function stopSftpTestServer(handle: SftpTestServerHandle): Promise<void> {
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  await fs.promises.rm(handle.root, { recursive: true, force: true });
}
