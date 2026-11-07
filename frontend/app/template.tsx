"use client";

import { motion } from "framer-motion";

/**
 * Re-mounts on every navigation, giving each page a soft entrance.
 * Opacity only: a lingering transform/filter here would become the containing
 * block for `position: fixed` dialogs inside the page.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}
