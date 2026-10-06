import type { MetricsQuery, MetricsResponse, Repository } from '@rat/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiError(
      payload?.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listRepositories(): Promise<{ items: Repository[] }> {
  return api('/repositories');
}

export function cloneRepository(input: {
  name: string;
  url: string;
  ref?: string;
}): Promise<Repository> {
  return api('/repositories/clone', { method: 'POST', body: JSON.stringify(input) });
}

export function uploadRepository(name: string, file: File): Promise<Repository> {
  const body = new FormData();
  body.append('name', name);
  body.append('file', file);
  return api('/repositories/upload', { method: 'POST', body });
}

export function getRepository(id: string): Promise<Repository> {
  return api(`/repositories/${id}`);
}

export function refreshRepository(id: string): Promise<{ repositoryId: string; state: string }> {
  return api(`/repositories/${id}/refresh`, { method: 'POST', body: '{}' });
}

export function deleteRepository(id: string): Promise<{ repositoryId: string; state: string }> {
  return api(`/repositories/${id}`, { method: 'DELETE' });
}

export function getMetrics(input: MetricsQuery): Promise<MetricsResponse> {
  return api('/metrics/query', { method: 'POST', body: JSON.stringify(input) });
}

export interface ObjectItem {
  id: string;
  kind: 'root' | 'directory' | 'file';
  path: string;
  parentId: string | null;
  depth: number;
  binaryObserved: boolean;
}

export interface AuthorItem {
  id: string;
  name: string;
  email: string | null;
  isManual: boolean;
  identities: number;
  identityIds: string[];
}

export interface CommitItem {
  id: string;
  oid: string;
  subject: string;
  committerAt: string;
  authorName: string;
  authorEmail: string;
  sequence: string;
}

export function listObjects(
  repositoryId: string,
  search = '',
  parentId?: string,
): Promise<{ items: ObjectItem[] }> {
  const params = new URLSearchParams({ limit: '200', search });
  if (parentId) params.set('parentId', parentId);
  return api(`/repositories/${repositoryId}/objects?${params}`);
}

export function listAuthors(analysisId: string): Promise<{ items: AuthorItem[] }> {
  return api(`/analyses/${analysisId}/authors`);
}

export function listCommits(
  analysisId: string,
  search = '',
): Promise<{ items: CommitItem[]; nextCursor: string | null }> {
  return api(`/analyses/${analysisId}/commits?limit=200&search=${encodeURIComponent(search)}`);
}

export interface CommitSetItem {
  id: string;
  name: string;
  createdAt: string;
  commitCount: number;
}

export function listCommitSets(analysisId: string): Promise<{ items: CommitSetItem[] }> {
  return api(`/analyses/${analysisId}/commit-sets`);
}

export function createCommitSet(input: {
  analysisId: string;
  name: string;
  commitIds: string[];
}): Promise<{ id: string; commitCount: number }> {
  return api('/commit-sets', { method: 'POST', body: JSON.stringify(input) });
}

export function updateCommitSet(
  id: string,
  input: { name?: string; commitIds?: string[] },
): Promise<{ id: string; analysisId: string; updated: true }> {
  return api(`/commit-sets/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteCommitSet(id: string): Promise<void> {
  return api(`/commit-sets/${id}`, { method: 'DELETE' });
}

export function mergeAuthors(input: {
  analysisId: string;
  name: string;
  identityIds: string[];
}): Promise<AuthorItem> {
  return api('/authors/merge', { method: 'POST', body: JSON.stringify(input) });
}

export function unmergeAuthor(groupId: string): Promise<{ id: string; unmerged: boolean }> {
  return api(`/authors/${groupId}/unmerge`, { method: 'POST', body: '{}' });
}
