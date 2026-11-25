import React from "react";
import { createRoot } from "react-dom/client";
import { ApprovalApp } from "./ApprovalApp";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<ApprovalApp />);
}
