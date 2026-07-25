/* Static search/browse index for the News page — the full archive as lean JSON
   (title/source/date/country/category/group + a pre-normalized search string),
   not styled HTML. Fetched once by NewsFeed.astro's client script for anything
   beyond the first NEWS_PAGE_SIZE items (paging, tab filtering, search) so the
   page itself doesn't have to ship the whole archive to render. See
   src/lib/newsSearch.ts for the shared logic and src/pages/news.astro for the
   bounded static render this complements. */
import type { APIRoute } from 'astro';
import { getNews, getCountries } from '../lib/dataHub';
import { resolveCategoryGroup, buildSearchText, normalize } from '../lib/newsSearch';
import type { NewsIndexItem } from '../lib/newsSearch';

export const prerender = true;

export const GET: APIRoute = () => {
  const countryNameMap: Record<string, string> = Object.fromEntries(
    getCountries().map(c => [c.code, c.name]),
  );
  function countryLabels(country: string | string[]): string[] {
    return (Array.isArray(country) ? country : [country]).map(code => (
      code === 'ALL' ? 'Caribbean regional' : countryNameMap[code] ?? code
    ));
  }

  const records: NewsIndexItem[] = getNews().map(item => {
    const { category, group } = resolveCategoryGroup(item);
    const countryStr = Array.isArray(item.country) ? item.country.join(',') : item.country;
    const searchText = normalize(buildSearchText({
      title: item.title,
      source: item.source,
      date: item.date,
      country: countryStr,
      category,
      countryLabels: countryLabels(item.country),
      tags: item.tags,
    }));
    return {
      id: item.id,
      title: item.title,
      source: item.source,
      date: item.date,
      country: item.country,
      url: item.url,
      category,
      group,
      searchText,
    };
  });

  return new Response(JSON.stringify(records), {
    headers: { 'Content-Type': 'application/json' },
  });
};
