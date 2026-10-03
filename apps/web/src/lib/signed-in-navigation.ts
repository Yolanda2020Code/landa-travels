export type AccountRole = "admin" | "advisor" | "traveller" | string | undefined;

export const baseAccountLinks = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "My Trips", href: "/bookings" },
  { label: "Impact & Rewards", href: "/rewards" },
];

export function getRoleAccountLinks(role: AccountRole) {
  const links = [...baseAccountLinks];
  if (role === "admin" || role === "advisor") {
    links.push({ label: "Advisor", href: "/advisor" });
  }
  if (role === "admin") {
    links.push({ label: "Quality Control", href: "/admin/chatbot-quality" });
  }
  return links;
}