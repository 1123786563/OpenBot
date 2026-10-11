import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_SORT_OPTIONS,
  type DocumentSortValue,
  getDocumentSortOption,
  nextSortValue,
  sortDocuments,
} from "./knowledge-sorting";

const docs = [
  {
    id: "a",
    title: "白皮书.pdf",
    created_at: "2026-01-03T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "b",
    title: "Annual report",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "c",
    title: "FAQ",
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
  },
] as const;

describe("document sorting", () => {
  test("six options cover three fields × two orders with no duplicates", () => {
    const values = DOCUMENT_SORT_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(6);
    for (const field of ["updated_at", "created_at", "title"] as const) {
      expect(
        DOCUMENT_SORT_OPTIONS.filter((o) => o.sortBy === field).length,
      ).toBe(2);
    }
  });

  test("getDocumentSortOption falls back to the default on an unknown value", () => {
    expect(getDocumentSortOption("created_desc").value).toBe("created_desc");
    // @ts-expect-error 故意传入非法值验证兜底
    expect(getDocumentSortOption("nonsense").value).toBe(DEFAULT_DOCUMENT_SORT);
  });

  test("created_at desc is the default and sorts newest first", () => {
    expect(DEFAULT_DOCUMENT_SORT).toBe("created_desc");
    expect(sortDocuments(docs, "created_desc").map((d) => d.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(sortDocuments(docs, "created_asc").map((d) => d.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  test("updated_at asc and desc", () => {
    expect(sortDocuments(docs, "updated_desc").map((d) => d.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(sortDocuments(docs, "updated_asc").map((d) => d.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  test("title asc uses natural numeric order, desc reverses it", () => {
    const numbered = [
      { id: "x10", title: "Chapter 10", created_at: "", updated_at: "" },
      { id: "x2", title: "Chapter 2", created_at: "", updated_at: "" },
      { id: "x1", title: "Chapter 1", created_at: "", updated_at: "" },
    ];
    expect(sortDocuments(numbered, "title_asc").map((d) => d.id)).toEqual([
      "x1",
      "x2",
      "x10",
    ]);
    expect(sortDocuments(numbered, "title_desc").map((d) => d.id)).toEqual([
      "x10",
      "x2",
      "x1",
    ]);
  });

  test("sorting is stable for equal keys (input order kept)", () => {
    const tied = [
      {
        id: "first",
        title: "same",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "",
      },
      {
        id: "second",
        title: "same",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "",
      },
      {
        id: "third",
        title: "same",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "",
      },
    ];
    expect(sortDocuments(tied, "title_asc").map((d) => d.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(sortDocuments(tied, "created_desc").map((d) => d.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("missing timestamps parse as epoch zero rather than NaN-ordering", () => {
    const mixed = [
      {
        id: "with",
        title: "t",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "",
      },
      { id: "without", title: "t", created_at: "", updated_at: "" },
    ];
    const sorted = sortDocuments(mixed, "created_asc").map((d) => d.id);
    expect(sorted).toEqual(["without", "with"]);
  });

  test("missing titles sort as empty strings", () => {
    const titled = [
      { id: "named", title: "B", created_at: "", updated_at: "" },
      { id: "untitled", title: undefined, created_at: "", updated_at: "" },
    ];
    expect(sortDocuments(titled, "title_asc").map((d) => d.id)).toEqual([
      "untitled",
      "named",
    ]);
  });

  test("sortDocuments does not mutate its input", () => {
    const input = [...docs];
    sortDocuments(input, "title_desc");
    expect(input.map((d) => d.id)).toEqual(docs.map((d) => d.id));
  });

  test("nextSortValue toggles within a field and jumps with defaults across fields", () => {
    const cases: [
      DocumentSortValue,
      "updated_at" | "created_at" | "title",
      DocumentSortValue,
    ][] = [
      ["updated_desc", "updated_at", "updated_asc"],
      ["updated_asc", "updated_at", "updated_desc"],
      ["created_desc", "created_at", "created_asc"],
      ["title_asc", "title", "title_desc"],
      ["created_desc", "title", "title_asc"],
      ["title_desc", "created_at", "created_desc"],
      ["created_asc", "updated_at", "updated_desc"],
    ];
    for (const [current, field, expected] of cases) {
      expect(nextSortValue(current, field)).toBe(expected);
    }
  });
});
