"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Counts = { all: number; selected: number; hold: number; rejected: number };
type ActCounts = { pending: number; done: number; all: number };

const GROUPS: { value: string; label: string; key: keyof Counts; dot?: string }[] = [
  { value: "", label: "All", key: "all" },
  { value: "selected", label: "Selected", key: "selected", dot: "dot-good" },
  { value: "hold", label: "Hold", key: "hold", dot: "dot-warn" },
  { value: "rejected", label: "Rejected", key: "rejected", dot: "dot-grey" },
];
const ACTS: { value: string; label: string; key: keyof ActCounts }[] = [
  { value: "all", label: "All", key: "all" },
  { value: "pending", label: "Pending", key: "pending" },
  { value: "done", label: "Done", key: "done" },
];

// The list's only controls: search, group, whether you've acted, role.
// Everything lives in the URL, so it survives refreshes and panel links.
export default function FilterBar({ group, act, groupCounts, actCounts }: { group: string; act: string; groupCounts: Counts; actCounts: ActCounts }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipSearch = useRef(false); // set by Clear, so the debounced search doesn't undo it

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete("tab"); // old-style links
    if (key !== "act") next.set("act", act);
    if (key !== "group" && group) next.set("group", group);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("c"); // close the panel when the list changes
    next.delete("view");
    router.replace(`${path}?${next.toString()}`, { scroll: false });
  };

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    if (skipSearch.current) {
      skipSearch.current = false;
      return;
    }
    if ((params.get("q") ?? "") === q) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set("q", q.trim()), 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const role = params.get("role") ?? "";
  const active = !!(params.get("q") || group || role || act !== "all");

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    if (q) skipSearch.current = true;
    setQ("");
    router.replace(path, { scroll: false });
  };

  return (
    <div className="filterbar" role="search">
      <div className="filter-row">
        <div className="seg seg-group" role="group" aria-label="Group">
          {GROUPS.map((g) => (
            <button key={g.key} aria-pressed={group === g.value} onClick={() => set("group", g.value)}>
              {g.dot && <span className={`dot ${g.dot}`} />} {g.label} <span className="seg-count">{groupCounts[g.key]}</span>
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Action">
          {ACTS.map((a) => (
            <button key={a.value} aria-pressed={act === a.value} onClick={() => set("act", a.value)}>
              {a.label} <span className={`seg-count${a.value === "pending" && actCounts.pending ? " seg-count-action" : ""}`}>{actCounts[a.key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="filter-row">
        <input
          type="search"
          className="filter-search"
          placeholder="Search by name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search candidates by name"
        />
        <div className="seg" role="group" aria-label="Role">
          {["", "PM", "SPM"].map((r) => (
            <button key={r || "all"} aria-pressed={role === r} onClick={() => set("role", r)}>{r || "All roles"}</button>
          ))}
        </div>
        {active && <button className="btn-link small filter-clear" onClick={clear}>Clear filters</button>}
      </div>
    </div>
  );
}
