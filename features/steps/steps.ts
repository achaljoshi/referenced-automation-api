import { createBdd } from 'playwright-bdd';
import { registerApiSteps, registerDataSteps } from '../../src/bdd';
import { test } from './fixtures';

// The vocabulary shared by every project ("I send a GET request to ...", "the response status is ...", "I set the variable ...")
// lives in the package. Add this project's own steps below, using the same Given/When/Then.
const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerApiSteps({ Given, When, Then });
