import { NextResponse } from "next/server";
import { COOKIE } from "../../../lib/auth";

function publicOrigin(request: Request) {
  const h = request.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const proto = h.get("x-forwarded-proto")?.split(",")[0] || "https";
  return `${proto}://${host}`;
}

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", publicOrigin(request)), 303);
  response.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
