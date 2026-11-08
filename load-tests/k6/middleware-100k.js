// Cenário: middleware com 100000 registros. Ver base-scenario.js e docs/TESTES_DE_CARGA.md.
import { createScenario } from './base-scenario.js';

const scenario = createScenario({ strategy: 'middleware', volume: 100000 });

export const options = scenario.options;
export const setup = scenario.setup;
export const teardown = scenario.teardown;
export default scenario.run;
