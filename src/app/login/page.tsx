"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error("Incorrect password");
      router.replace(from);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-badge">🎵</div>
      <h1>The Music Genome Project</h1>
      <p className="muted">This is a private preview. Enter the access password.</p>
      <form onSubmit={submit} className="login-form">
        <input
          className="search-input"
          type="password"
          placeholder="Access password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button className="btn-spotify" type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
      {error && <p className="login-error">{error}</p>}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="container center" style={{ minHeight: "80vh" }}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
