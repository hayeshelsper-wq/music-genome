import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, makeToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const password = process.env.AUTH_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!password || !secret) {
    // Auth disabled — treat as open.
    return NextResponse.json({ ok: true, disabled: true });
  }
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.password !== password) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await makeToken(secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
