export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  wrong: "That password isn't right.",
  unset: "No password is set. Add DASHBOARD_PASSWORD to the server's environment, then restart it.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const unset = !process.env.DASHBOARD_PASSWORD;
  return (
    <main className="login">
      <form method="post" action="/api/login" className="card login-card">
        <h1>Kargo Hiring</h1>
        <p className="muted small">Candidate data is private. Sign in to continue.</p>
        {(error || unset) && <div className="error small">{ERRORS[error ?? "unset"] ?? ERRORS.wrong}</div>}
        <input type="hidden" name="next" value={next ?? "/"} />
        <label className="field">
          <span>Password</span>
          <input type="password" name="password" autoComplete="current-password" autoFocus required disabled={unset} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={unset}>Sign in</button>
      </form>
    </main>
  );
}
