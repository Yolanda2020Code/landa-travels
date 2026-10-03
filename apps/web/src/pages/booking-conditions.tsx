import { LegalPageLayout } from "@/components/legal-page-layout";
import { FileText } from "lucide-react";

export default function BookingConditions() {
  const sections = [
    { id: "introduction", title: "Introduction" },
    { id: "demonstration-only", title: "Demonstration Only" },
    { id: "estimates-and-impact", title: "Estimates & Climate Impact" },
    { id: "future-live-bookings", title: "Future Live Bookings" }
  ];

  return (
    <LegalPageLayout 
      title="Booking Conditions" 
      description="Conditions for Landa Travels illustrative itineraries, estimates, and demonstration booking requests."
      lastUpdated="19 September 2026" 
      icon={<FileText size={24} />} 
      sections={sections}
    >
      <section id="introduction" className="scroll-mt-32">
        <h2>Introduction</h2>
        <p>
          These conditions outline the parameters surrounding the trip generation and booking request workflows within the Landa Travels platform. 
        </p>
        <div className="not-prose my-6 p-4 rounded-xl bg-primary/5 border border-primary/20 text-sm text-muted-foreground italic">
          Note: This document is provided to ensure transparency regarding platform capabilities and does not constitute formal legal advice.
        </div>
      </section>

      <section id="demonstration-only" className="scroll-mt-32 mt-10">
        <h2>Demonstration & Illustrative Purposes</h2>
        <p>
          Any action labelled as a "Booking Request," "Reservation," or "Quote" within the current Landa Travels interface is an illustrative simulation.
        </p>
        <p>
          We provide these tools to demonstrate how a transparent, sustainability-focused booking process operates. <strong>No real-world financial transactions are processed, and no live inventory is secured on your behalf.</strong> Any generated confirmation documents or itinerary schedules should not be relied upon for actual travel.
        </p>
      </section>

      <section id="estimates-and-impact" className="scroll-mt-32 mt-10">
        <h2>Estimates & Climate Impact</h2>
        <p>
          Our platform works diligently to estimate the carbon footprint and community impact of potential trips based on available scientific models. However, these figures are predictive estimates rather than guaranteed certifications. 
        </p>
        <p>
          When you submit a demonstration booking request, the associated climate-impact metrics are scenario estimates designed to inform comparison, rather than a certified real-time carbon audit. Price, availability, schedule, route, operator, certification, and emissions information must be checked with the relevant provider before actual travel.
        </p>
      </section>

      <section id="future-live-bookings" className="scroll-mt-32 mt-10">
        <h2>Future Live Bookings</h2>
        <p>
          If Landa Travels later facilitates live reservations, the interface will identify the responsible travel provider and display the applicable live price, payment, change, cancellation, refund, fulfilment, and complaint terms before commitment. Until those terms are shown and a provider confirms a reservation, no demonstration request creates a booking or payment obligation.
        </p>
      </section>
    </LegalPageLayout>
  );
}