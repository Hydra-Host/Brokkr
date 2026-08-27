import { tmpdir } from 'node:os';
import { _addAllowedRootForTesting } from './operations/deploy/target-path';

_addAllowedRootForTesting(tmpdir());
