export const OPERATOR_POLICY = 'OPERATOR_POLICY';

export interface OperatorCandidateOrg {
  isInstanceOperator: boolean;
}

export interface OperatorPolicy {
  isInstanceOperator(org: OperatorCandidateOrg): boolean;
}

export class DesignationOperatorPolicy implements OperatorPolicy {
  isInstanceOperator(org: OperatorCandidateOrg): boolean {
    return org.isInstanceOperator === true;
  }
}
