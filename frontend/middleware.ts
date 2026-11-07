import { withAuth } from "next-auth/middleware";

/** Every page requires sign-in except the auth and legal pages (excluded in `matcher` below). */
export default withAuth({ pages: { signIn: "/login" } });

export const config = {
  matcher: ["/((?!login|register|terms|privacy|api/auth|api/register|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
