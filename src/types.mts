import type { Endpoints } from '@octokit/types';

// Describe only the GitHub API surface these scripts use. Response fields stay
// small enough for readable fixtures; request parameters come from Octokit.
type PullResponse = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'];
export type PullRequest = Pick<PullResponse, 'state'> & {
  labels: Array<Pick<PullResponse['labels'][number], 'name'>>;
  head: Pick<PullResponse['head'], 'sha'>;
  user: Pick<PullResponse['user'], 'login'>;
  assignees: Array<{ login: string }> | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
};

type CommentResponse = Endpoints['GET /repos/{owner}/{repo}/issues/comments/{comment_id}']['response']['data'];
export type Comment = Pick<CommentResponse, 'id' | 'body'>;

type Request<Route extends keyof Endpoints> = (
  args: Endpoints[Route]['parameters'],
) => Promise<unknown>;

export interface IssueMethods {
  removeLabel: Request<'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}'>;
  addLabels: Request<'POST /repos/{owner}/{repo}/issues/{issue_number}/labels'>;
  addAssignees: Request<'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees'>;
  createComment: Request<'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'>;
  updateComment: Request<'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'>;
  deleteComment: Request<'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}'>;
  listComments: Request<'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'>;
}

export interface PullMethods {
  get(args: Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['parameters']): Promise<{ data: PullRequest }>;
  merge: Request<'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge'>;
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

export interface GitHubClient extends CommentClient {
  rest: {
    issues: IssueMethods;
    pulls: PullMethods;
  };
}

type Run = Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}']['response']['data'];
type RunPullRequest = NonNullable<Run['pull_requests']>[number];
export interface WorkflowContext {
  repo: { owner: string; repo: string };
  payload: {
    workflow_run?: Pick<Run, 'head_sha' | 'conclusion'> & {
      pull_requests: Array<{
        number: RunPullRequest['number'];
        head: Pick<RunPullRequest['head'], 'sha'>;
      }>;
    };
  };
}

// The subset of @actions/core used by every entry point.
export interface Core {
  setOutput(name: string, value: string): void;
  info(message: string): void;
  warning?(message: string): void;
}

export interface PolicyDependencies {
  botLogin?: string;
  github: GitHubClient;
  context: WorkflowContext;
  core: Core;
}

export interface NotificationDependencies extends PolicyDependencies {
  env?: NodeJS.ProcessEnv;
}

export interface ReportContext {
  repo: { owner: string; repo: string };
  issue: { number: number };
  serverUrl: string;
  runId: number;
  eventName: string;
}
