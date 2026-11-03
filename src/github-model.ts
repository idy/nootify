import type { PullRequest } from './github.js';

export interface GitHubPull {
  id: string;
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  updatedAt: string;
  repository: { nameWithOwner: string };
  author?: { login: string } | null;
  headRepository?: { nameWithOwner: string } | null;
  headRefName?: string;
  reviewDecision?: string | null;
  mergeable?: string | null;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: {
    state?: string;
    contexts?: { totalCount: number; nodes: (CheckContext | null)[] } | null;
  } | null } | null } | null)[] } | null;
  reviews?: { totalCount?: number; nodes?: ({ author?: { login: string } | null; state: string; submittedAt?: string } | null)[] } | null;
}
interface CheckContext { __typename: string; status?: string; conclusion?: string | null; state?: string }
export interface PullScope { authors: string[]; ownedOwners: string[]; excludeRepositories: string[]; localForks?: string[] }
export const key = (value: string): string => value.toLowerCase();
export const ownerOf = (repository: string): string => repository.split('/')[0] ?? '';
export const unique = (values: string[]): string[] => [...new Map(values.map(value => [key(value), value])).values()];
const includes = (values: string[], value: string): boolean => values.some(item => key(item) === key(value));
const count = (value: number | undefined): number => Number.isFinite(value) && value! >= 0 ? value! : 0;

/** GitHub remotes only; never return URL credentials or execute repository code. */
export function parseGitHubRemote(value: string): string | undefined {
  const input = value.trim();
  let path = input.match(/^(?:[^@\s/:]+@)?github\.com:([^\s]+)$/i)?.[1];
  if (!path) {
    try {
      const url = new URL(input);
      if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || key(url.hostname) !== 'github.com') return;
      path = url.pathname;
    } catch { return; }
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(path) && !['.', '..'].includes(path.split('/')[1]) ? path : undefined;
}

export interface GitHubPullReference { repository: string; number: number; url: string }
/** Normalize explicit PR links from session metadata; external hosts and URL credentials never become subscriptions. */
export function parseGitHubPull(value: unknown): GitHubPullReference | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) return;
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (!match) return;
    const repository = parseGitHubRemote(`https://github.com/${match[1]}`);
    const number = Number(match[2]);
    if (!repository || !Number.isSafeInteger(number) || number < 1) return;
    return { repository, number, url: `https://github.com/${repository}/pull/${number}` };
  } catch { return; }
}

/** Destinations in internal owners qualify regardless of author or local clones. */
export function classifyPull(pr: GitHubPull, scope: PullScope): 'internal' | 'upstream' | undefined {
  const repository = pr.repository?.nameWithOwner;
  if (pr.state !== 'OPEN' || !repository || includes(scope.excludeRepositories, repository)) return;
  if (includes(scope.ownedOwners, ownerOf(repository))) return 'internal';
  const head = pr.headRepository?.nameWithOwner;
  if (pr.isCrossRepository === false || (head && key(head) === key(repository)) || (!head && pr.isCrossRepository !== true)) return;
  if (includes(scope.authors, pr.author?.login ?? '')) return 'upstream';
  if (head && (includes(scope.ownedOwners, ownerOf(head)) || includes(scope.localForks ?? [], head))) return 'upstream';
}

export function normalizePull(pr: GitHubPull, warn: (message: string) => void = () => {}): PullRequest {
  const ci: PullRequest['ci'] = { state: 'UNKNOWN', passed: 0, failed: 0, pending: 0, total: 0 };
  if (pr.commits && Array.isArray(pr.commits.nodes)) {
    const commit = pr.commits.nodes.at(-1)?.commit;
    if (commit && Object.hasOwn(commit, 'statusCheckRollup')) {
      const rollup = commit.statusCheckRollup;
      if (!rollup) ci.state = 'NONE';
      else if (Array.isArray(rollup.contexts?.nodes)) {
        const contexts = rollup.contexts.nodes.filter((item): item is CheckContext => !!item);
        for (const item of contexts) {
          if ((item.__typename === 'CheckRun' && item.status === 'COMPLETED'
            && ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(item.conclusion ?? ''))
            || (item.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(item.state ?? ''))) ci.failed++;
          else if ((item.__typename === 'CheckRun' && item.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(item.conclusion ?? ''))
            || (item.__typename === 'StatusContext' && item.state === 'SUCCESS')) ci.passed++;
          else ci.pending++;
        }
        ci.total = Math.max(count(rollup.contexts!.totalCount), contexts.length);
        ci.state = ci.failed ? 'FAILURE' : ci.pending ? 'PENDING' : ci.passed ? 'SUCCESS' : 'NONE';
        if (ci.total > contexts.length) {
          ci.state = ({ SUCCESS: 'SUCCESS', FAILURE: 'FAILURE', ERROR: 'FAILURE', PENDING: 'PENDING', EXPECTED: 'PENDING' } as Record<string, string>)[rollup.state ?? '']
            ?? (ci.failed ? 'FAILURE' : 'UNKNOWN');
          warn(`${pr.repository.nameWithOwner}#${pr.number}: inspected ${contexts.length} of ${ci.total} CI contexts; counts are partial and the aggregate determines CI state.`);
        }
      }
    }
  }
  let reviewDecision = pr.reviewDecision || 'UNKNOWN';
  if (!pr.reviewDecision && Array.isArray(pr.reviews?.nodes)) {
    const latest = new Map<string, { state: string; date: string }>();
    for (const review of pr.reviews.nodes) {
      if (!review?.author?.login || !review.submittedAt || review.state === 'PENDING') continue;
      const login = key(review.author.login);
      const previous = latest.get(login);
      // Comments do not undo an opinion; a dismissal does.
      if (review.state === 'COMMENTED' && previous && previous.state !== 'COMMENTED') continue;
      if (!previous || previous.state === 'COMMENTED' && review.state !== 'COMMENTED' || review.submittedAt >= previous.date) {
        latest.set(login, { state: review.state, date: review.submittedAt });
      }
    }
    const states = [...latest.values()].map(review => review.state);
    reviewDecision = states.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : states.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
    if (count(pr.reviews.totalCount) > pr.reviews.nodes.length) {
      warn(`${pr.repository.nameWithOwner}#${pr.number}: only the latest 30 reviews were inspected; older reviewer decisions may be omitted.`);
    }
  }
  return {
    number: pr.number, url: pr.url, title: pr.title ?? '', isDraft: Boolean(pr.isDraft), repository: pr.repository.nameWithOwner,
    author: pr.author?.login ?? 'ghost', ...(pr.headRepository?.nameWithOwner ? { headRepository: pr.headRepository.nameWithOwner } : {}),
    updatedAt: pr.updatedAt, ...(pr.headRefName ? { headBranch: pr.headRefName } : {}), reviewDecision, mergeable: pr.mergeable || 'UNKNOWN', ci,
  };
}

/** Oldest updates first, missing dates last, with locale-independent ties. */
export function comparePulls(a: PullRequest, b: PullRequest): number {
  const dateA = Date.parse(a.updatedAt); const dateB = Date.parse(b.updatedAt);
  const dates = Number(!Number.isFinite(dateA)) - Number(!Number.isFinite(dateB));
  const text = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  return dates || (Number.isFinite(dateA) && Number.isFinite(dateB) ? dateA - dateB : 0)
    || text(key(a.repository), key(b.repository)) || a.number - b.number || text(a.url, b.url);
}
