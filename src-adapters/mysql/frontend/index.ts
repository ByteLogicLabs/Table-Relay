// MySQL frontend contributions. The omni loader (`src/lib/adapter-frontend/loader.ts`)
// picks this up via `import.meta.glob`; do not register it from a central
// file.
import type { AdapterFrontend } from '../../../src/lib/adapter-frontend/types';
import { registerSharedSqlCompletion } from '../../../src/lib/query-completion/sql-shared';

const frontend: AdapterFrontend = {
  key: 'mysql',
  registerQueryCompletion: registerSharedSqlCompletion,
};

export default frontend;
