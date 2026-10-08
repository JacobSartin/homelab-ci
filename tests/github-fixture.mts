import type { IssueMethods } from '../src/types.mts';

export interface IssueCall {
  name: keyof IssueMethods;
  args: Record<string, unknown>;
}

// Explicit methods let TypeScript verify fixtures against the same interface
// used by production code, without casting incomplete mocks to a full client.
export function recordIssues(): { issues: IssueMethods; calls: IssueCall[] } {
  const calls: IssueCall[] = [];
  const record = (name: keyof IssueMethods) => async (args: Record<string, unknown>): Promise<void> => {
    calls.push({ name, args });
  };
  return {
    calls,
    issues: {
      addAssignees: record('addAssignees'),
      createComment: record('createComment'),
      updateComment: record('updateComment'),
      deleteComment: record('deleteComment'),
      listComments: record('listComments'),
    },
  };
}
