"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { undo } from "../email-actions";
import Countdown from "./Countdown";

export default function UndoButton({ emailId, sendAfter }: { emailId: string; sendAfter: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <span className="undo">
      <span className="small"><Countdown until={sendAfter} onDone={() => setTimeout(() => router.refresh(), 12_000)} /></span>
      <button
        className="btn btn-small"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await undo(emailId);
            if (!r.ok) alert(r.error);
            router.refresh();
          })
        }
      >
        Undo
      </button>
    </span>
  );
}
