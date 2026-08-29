// ---------------------------------------------------------------------------
// White-label branding config
//
// This is the single place to swap in a client's identity when reusing this
// portal for a new customer. Update the values below and every screen
// (login, sidebar, browser tab) picks them up automatically.
// ---------------------------------------------------------------------------
import clientLogoPlaceholder from "../assets/BElogo.jpeg";
import agencyLogo from "../assets/DAlogo.jpg";

export const branding = {
  // The clinic / customer this instance is deployed for.
  // TODO: replace clientLogoPlaceholder above with the client's real logo file
  // (transparent PNG or SVG recommended, roughly square).
  clientName: "BE CLinique",
  clientLogo: clientLogoPlaceholder,
  loginTagline: "Sign in to view patient conversations",

  // Your agency's identity, shown as a small "built by" credit.
  agencyName: "DA Smarketing Solutions",
  agencyLogo: agencyLogo,
};
