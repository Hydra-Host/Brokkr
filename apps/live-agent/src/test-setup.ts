import { tmpdir } from 'node:os';
import { _addAllowedRootForTesting } from './operations/deploy/targetPath';

_addAllowedRootForTesting(tmpdir());
