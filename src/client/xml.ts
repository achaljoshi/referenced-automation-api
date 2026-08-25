import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const builder = new XMLBuilder({ ignoreAttributes: false, format: false });
const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });

/** Converts a plain object to an XML string, e.g. { user: { id: 1 } } -> <user><id>1</id></user>. */
export function toXml(value: unknown): string {
  return builder.build(value);
}

/** Parses an XML string into a plain object, traversable the same way a JSON body is. */
export function fromXml<T = unknown>(xml: string): T {
  return parser.parse(xml) as T;
}
