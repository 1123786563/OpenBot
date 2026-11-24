import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { peopleListQueryOptions } from "@/lib/people/queries";

test("access denial to the people list clears other searches and their pagination", async () => {
  const cache = new QueryClient();
  const originalFetch = global.fetch;
  let status = 403;
  global.fetch = Object.assign(
    async () => Response.json({ error: "People unavailable" }, { status }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const list = peopleListQueryOptions();
    const priorSearch = peopleListQueryOptions("prior search");
    const cached = {
      pages: [{ people: [], nextCursor: "next" }],
      pageParams: [""],
    };
    cache.setQueryData(list.queryKey, cached);
    cache.setQueryData(priorSearch.queryKey, cached);

    await expect(
      cache.fetchInfiniteQuery(peopleListQueryOptions("new search")),
    ).rejects.toMatchObject({ status: 403 });
    const cleared = { pages: [], pageParams: [] };
    expect(cache.getQueryData(list.queryKey)).toMatchObject(cleared);
    expect(cache.getQueryData(priorSearch.queryKey)).toMatchObject(cleared);

    status = 503;
    await expect(
      cache.fetchInfiniteQuery({ ...list, retry: false }),
    ).rejects.toMatchObject({ status: 503 });
    expect(cache.getQueryData(list.queryKey)).toMatchObject(cleared);
  } finally {
    global.fetch = originalFetch;
    cache.clear();
  }
});
