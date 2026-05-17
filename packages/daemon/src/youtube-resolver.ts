export interface SearchResult {
  title: string;
  artist: string;
  duration: number;
  youtubeUrl: string;
}

const INNERTUBE_ENDPOINT = 'https://www.youtube.com/youtubei/v1/search';
// EgIQAQ== = video-only filter
const VIDEO_FILTER = 'EgIQAQ%3D%3D';

export function parseDuration(text: string): number {
  const parts = text.split(':').map(Number);
  if (parts.length === 2) return (parts[0]! * 60) + parts[1]!;
  if (parts.length === 3) return (parts[0]! * 3600) + (parts[1]! * 60) + parts[2]!;
  return 0;
}

export function searchYoutube(query: string, limit = 5): Promise<SearchResult[]> {
  return fetch(INNERTUBE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
      query,
      params: VIDEO_FILTER,
    }),
  })
    .then((r) => r.json() as Promise<Record<string, unknown>>)
    .then((data) => {
      const contents = (
        (data['contents'] as Record<string, unknown>)?.['twoColumnSearchResultsRenderer'] as Record<string, unknown>
      )?.['primaryContents'] as Record<string, unknown>;
      const items = (
        ((contents?.['sectionListRenderer'] as Record<string, unknown>)
          ?.['contents'] as Record<string, unknown>[])?.[0]
          ?.['itemSectionRenderer'] as Record<string, unknown>
      )?.['contents'] as Record<string, unknown>[] | undefined;

      if (!Array.isArray(items)) return [];

      const results: SearchResult[] = [];
      for (const item of items) {
        if (results.length >= limit) break;
        const vr = item['videoRenderer'] as Record<string, unknown> | undefined;
        if (!vr) continue;
        const videoId = String(vr['videoId'] ?? '');
        if (!videoId) continue;
        const title = String(
          ((vr['title'] as Record<string, unknown>)?.['runs'] as Record<string, unknown>[])?.[0]?.['text'] ?? 'Unknown'
        );
        const artist = String(
          ((vr['ownerText'] as Record<string, unknown>)?.['runs'] as Record<string, unknown>[])?.[0]?.['text'] ?? 'Unknown'
        );
        const durationText = String(
          (vr['lengthText'] as Record<string, unknown>)?.['simpleText'] ?? '0:00'
        );
        results.push({
          title,
          artist,
          duration: parseDuration(durationText),
          youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }
      return results;
    });
}
