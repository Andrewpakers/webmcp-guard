import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/console-shell";

/**
 * Everything in this route group is behind the admin token. The shell is a
 * client component because the token lives in the browser — there is no server
 * session to check here (`docs/03-architecture.md`: the console is a stateless
 * client of the portal's guard API).
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
