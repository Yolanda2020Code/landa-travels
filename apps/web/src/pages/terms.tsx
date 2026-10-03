import { LegalPageLayout } from "@/components/legal-page-layout";
import { Scale } from "lucide-react";

export default function Terms() {
  const sections = [
    { id: "introduction", title: "Introduction" },
    { id: "platform-nature", title: "Nature of the Platform" },
    { id: "user-responsibilities", title: "User Responsibilities" },
    { id: "content-and-ip", title: "Content & Intellectual Property" },
    { id: "limitation-of-liability", title: "Limitation of Liability" },
    { id: "termination", title: "Termination" }
  ];

  return (
    <LegalPageLayout 
      title="Terms of Service" 
      description="Terms for using the Landa Travels sustainable travel planning demonstration."
      lastUpdated="19 September 2026" 
      icon={<Scale size={24} />} 
      sections={sections}
    >
      <section id="introduction" className="scroll-mt-32">
        <h2>Introduction</h2>
        <p>
          Welcome to Landa Travels. These Terms of Service govern your access to and use of our sustainable travel planning platform. By creating an account or using our tools, you agree to abide by these terms.
        </p>
        <div className="not-prose my-6 p-4 rounded-xl bg-primary/5 border border-primary/20 text-sm text-muted-foreground italic">
          Note: This document is provided to outline operational boundaries and does not constitute formal legal advice.
        </div>
      </section>

      <section id="platform-nature" className="scroll-mt-32 mt-10">
        <h2>Nature of the Platform</h2>
        <p>
          Landa Travels is currently designed as a planning and discovery environment focused on sustainability and climate impact. 
        </p>
        <p>
          <strong>Crucially, all pricing, travel estimates, carbon calculations, and "booking requests" generated on the platform are illustrative and for demonstration purposes only.</strong> They do not constitute live quotes, confirmed reservations, official climate certifications, or binding legal offers. Actual travel availability and exact environmental impact will vary once finalized with a verified operator.
        </p>
      </section>

      <section id="user-responsibilities" className="scroll-mt-32 mt-10">
        <h2>User Responsibilities</h2>
        <p>
          When utilizing Landa Travels, you agree to:
        </p>
        <ul>
          <li>Provide accurate information during the registration process.</li>
          <li>Maintain the security and confidentiality of your authentication credentials.</li>
          <li>Use the artificial intelligence assistant responsibly and refrain from attempting to bypass system instructions or submit malicious inputs.</li>
          <li>Ensure that any content you upload, including profile photographs, complies with community standards and does not infringe on third-party rights.</li>
        </ul>
      </section>

      <section id="content-and-ip" className="scroll-mt-32 mt-10">
        <h2>Content & Intellectual Property</h2>
        <p>
          The platform's original design, software, methodology, and written content may be protected by intellectual-property rights. You may use the platform for personal, non-commercial travel planning, but you may not copy, interfere with, or misrepresent the service. Content and trademarks belonging to third parties remain theirs.
        </p>
      </section>

      <section id="limitation-of-liability" className="scroll-mt-32 mt-10">
        <h2>Limitation of Liability</h2>
        <p>
          Because current outputs are illustrative and intended for planning purposes, you should independently verify availability, prices, entry requirements, safety information, accessibility, and environmental claims before relying on them. To the extent permitted by applicable law, Landa Travels does not accept responsibility for decisions based solely on demonstration outputs. Nothing in these terms excludes rights or responsibilities that cannot lawfully be excluded.
        </p>
      </section>

      <section id="termination" className="scroll-mt-32 mt-10">
        <h2>Termination</h2>
        <p>
          We may restrict access when reasonably necessary to protect users, the platform, or others, including where these terms are materially breached. You can stop using the service at any time and may contact us to request account closure. Sections that by their nature should continue, including intellectual-property and liability provisions, may survive termination.
        </p>
      </section>
    </LegalPageLayout>
  );
}