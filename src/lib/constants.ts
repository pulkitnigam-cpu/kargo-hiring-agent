export const ROLES = ["PM", "SPM"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_TITLE: Record<Role, string> = {
  PM: "Product Manager",
  SPM: "Senior Product Manager",
};

// §6.4 state machine. Phase 1 only produces PARSED and NEEDS_MANUAL_LOOK.
export const CANDIDATE_STATUS = {
  UPLOADED: "UPLOADED",
  PARSED: "PARSED",
  SCORED: "SCORED",
  SELECTED: "SELECTED",
  HOLD: "HOLD",
  REJECTED: "REJECTED",
  NEEDS_MANUAL_LOOK: "NEEDS_MANUAL_LOOK",
  INVITED: "INVITED",
  HOLD_NOTIFIED: "HOLD_NOTIFIED",
  REGRET_SENT: "REGRET_SENT",
} as const;
export type CandidateStatus = (typeof CANDIDATE_STATUS)[keyof typeof CANDIDATE_STATUS];

export const CV_EXTENSIONS = [".pdf", ".docx"] as const;
export const ZIP_EXTENSION = ".zip";

// Anything shorter than this after parsing is treated as "no readable text"
// (typically a scanned image PDF).
export const MIN_CV_TEXT_CHARS = 200;

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
