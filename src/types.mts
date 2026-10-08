import type { Endpoints } from '@octokit/types';

// Describe only the GitHub API surface these scripts use. Response fields stay
// small enough for readable fixtures; request parameters come from Octokit.
type CommentResponse = Endpoints['GET /repos/{owner}/{repo}/issues/comments/{comment_id}']['response']['data'];
export type Comment = Pick<CommentResponse, 'id' | 'body'>;

type Request<Route extends keyof Endpoints> = (
  args: Endpoints[Route]['parameters'],
) => Promise<unknown>;

export interface IssueMethods {
  createComment: Request<'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'>;
  updateComment: Request<'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'>;
  deleteComment: Request<'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}'>;
  listComments: Request<'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'>;
}

export interface CommentClient {
  rest: {
    issues: Pick<IssueMethods, 'createComment' | 'updateComment' | 'deleteComment' | 'listComments'>;
  };
  paginate(
    method: IssueMethods['listComments'],
    args: Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/comments']['parameters'],
  ): Promise<Comment[]>;
}

// The subset of @actions/core used by every entry point.
export interface Core {
  setOutput(name: string, value: string): void;
  info(message: string): void;
  warning?(message: string): void;
}

export interface ReportContext {
  repo: { owner: string; repo: string };
  issue: { number: number };
  serverUrl: string;
  runId: number;
  eventName: string;
}
