import { LegalPageLayout } from "@/components/legal-page-layout";
import { Shield } from "lucide-react";
import { Link } from "wouter";

export default function Privacy() {
  const sections = [
    { id: "introduction", title: "Introduction" },
    { id: "information-collection", title: "Information We Collect" },
    { id: "information-usage", title: "How We Use Your Data" },
    { id: "data-sharing", title: "Service Providers & Sharing" },
    { id: "retention", title: "Data Retention" },
    { id: "your-rights", title: "Your Choices & Rights" },
    { id: "recruitment-applications", title: "Recruitment Applications" },
    { id: "contact-and-communications", title: "Contact & Communications" }
  ];

  return (
    <LegalPageLayout 
      title="Privacy Policy" 
      description="How Landa Travels handles account, trip-planning, contact, assistant, analytics, and future recruitment data."
      lastUpdated="19 September 2026" 
      icon={<Shield size={24} />} 
      sections={sections}
    >
      <section id="introduction" className="scroll-mt-32">
        <h2>Introduction</h2>
        <p>
          At Landa Travels, trust is built on transparent evidence and clear user control. This policy explains the information handled by the current demonstration platform, why it is used, and the choices available to you.
        </p>
        <div className="not-prose my-6 p-4 rounded-xl bg-primary/5 border border-primary/20 text-sm text-muted-foreground italic">
          Note: This document is provided for operational clarity and does not constitute formal legal advice.
        </div>
      </section>

      <section id="information-collection" className="scroll-mt-32 mt-10">
        <h2>Information We Collect</h2>
        <p>To provide a highly customized and responsible travel planning experience, we collect the following types of information:</p>
        <ul>
          <li><strong>Authentication & Profile Data:</strong> Clerk provides authentication and may hold your email address, name, account identifiers, and profile image. The Landa profile can also include a display name, home base, and biography.</li>
          <li><strong>Travel Planning Data:</strong> We process the trip details you provide, such as broad origin and destination, travel dates, group size, preferences, saved trips, and demonstration booking requests. Do not submit passport numbers, payment-card details, passwords, or other credentials.</li>
          <li><strong>Assistant Conversations:</strong> We store redacted conversation turns and privacy-minimised trip context so the assistant can continue a planning session. Precise location and detailed accessibility information are excluded or generalised in the persisted analytics view.</li>
          <li><strong>Contact & Recruitment Submissions:</strong> If you use the contact form, we store the name, email address, topic, message, and consent needed to respond. If you apply to join the mission, we store your name, email address, relevant experience and interests, consent record, and privately uploaded CV.</li>
          <li><strong>Operational Records:</strong> We record privacy-minimised events such as assistant outcomes, response latency, errors, and administrator review labels. Administrator access to quality information is logged.</li>
        </ul>
      </section>

      <section id="information-usage" className="scroll-mt-32 mt-10">
        <h2>How We Use Your Data</h2>
        <p>We process your data strictly to facilitate your experience and improve the Landa Travels platform:</p>
        <ul>
          <li><strong>Service Delivery:</strong> To authenticate your account, maintain your profile, and power the trip planning and saving capabilities.</li>
          <li><strong>Operational Analytics:</strong> To review redacted operational data, diagnose errors, measure assistant outcomes, and improve the interface. Operational telemetry is kept separate from labelled model-evaluation evidence.</li>
          <li><strong>Model Evaluations:</strong> To import and compare labelled test datasets and model results. These evaluation records are not presented as measurements of an individual traveller.</li>
          <li><strong>Communication:</strong> To respond to inquiries you submit. The current contact consent does not sign you up for marketing.</li>
        </ul>
      </section>

      <section id="data-sharing" className="scroll-mt-32 mt-10">
        <h2>Service Providers & Sharing</h2>
        <p>
          We do not sell your personal data. Information is handled by providers needed to run the platform, including Clerk for authentication and Hugging Face for application hosting and the configured storage service for uploads. Travel-data providers may receive the limited route or trip details required for a request when live integrations are enabled. Their own terms and privacy notices may also apply.
        </p>
      </section>

      <section id="retention" className="scroll-mt-32 mt-10">
        <h2>Data Retention</h2>
        <p>
          Redacted assistant conversations, operational events, and human review labels are subject to a 30-day cleanup period. Administrator quality-access audit records are subject to a 90-day cleanup period. Recruitment applications and CVs are marked for deletion after 90 days unless a longer period is agreed with the applicant or required for an active recruitment process. Saved profiles, trips, demonstration booking records, rewards, and contact inquiries may remain while needed to provide the service, maintain records, or respond to you.
        </p>
      </section>

      <section id="recruitment-applications" className="scroll-mt-32 mt-10">
        <h2>Recruitment Applications</h2>
        <p>
          Recruitment details are used only to review your interest in contributing to Landa Travels and to contact you about that application. CV files are stored in private application storage and are not publicly listed. Access is restricted to the authenticated founder account. Duplicate applications from the same email address are blocked to avoid unnecessary copies. You may use the Contact page to request access, correction, or deletion.
        </p>
      </section>

      <section id="your-rights" className="scroll-mt-32 mt-10">
        <h2>Your Choices & Rights</h2>
        <p>
          You can edit the profile fields currently available in your dashboard and archive saved trips. You may choose not to create an account, although saving, resuming, rewards, and demonstration booking features require sign-in. To ask about access, correction, deletion, or account closure that is not available through the interface, use the Contact page. We may need to verify the request before acting on it.
        </p>
      </section>

      <section id="contact-and-communications" className="scroll-mt-32 mt-10">
        <h2>Contact & Communications</h2>
        <p>
          If you have questions about this policy or our data practices, please reach out to us using our <Link href="/contact" className="font-bold underline">Contact page</Link>. We are committed to addressing your concerns transparently and promptly.
        </p>
      </section>
    </LegalPageLayout>
  );
}