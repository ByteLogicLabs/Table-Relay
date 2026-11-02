import type { AdapterFrontend } from '../../../src/lib/adapter-frontend/types';
import { registerSharedSqlCompletion } from '../../../src/lib/query-completion/sql-shared';

const frontend: AdapterFrontend = {
  key: 'sqlite',
  registerQueryCompletion: registerSharedSqlCompletion,
};

export default frontend;
