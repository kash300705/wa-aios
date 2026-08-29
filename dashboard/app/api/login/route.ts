import { NextResponse } from "next/server";
import { COOKIE, checkPassword, cookieOptions, issueToken } from "../../../lib/auth";

/**
 * Public origin of the request. Behind Render's / Vercel's proxy `request.url`
 * is the internal `http://localhost:PORT`, so a redirect built from it lands on
 * a dead localhost URL. Trust the forwarded headers instead.
 */
function publicOrigin(request: Request) {
  const h = request.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const proto = h.get("x-forwarded-proto")?.split(",")[0] || "https";
  return `${proto}://${host}`;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const supplied = String(form.get("password") ?? "");
  const origin = publicOrigin(request);
  if (!checkPassword(supplied)) {
    await new Promise((r) => setTimeout(r, 600)); // blunt brute-force damper
    return NextResponse.redirect(new URL("/login?error=1", origin), 303);
  }
  const response = NextResponse.redirect(new URL("/", origin), 303);
  response.cookies.set(COOKIE, issueToken(), cookieOptions);
  return response;
}
