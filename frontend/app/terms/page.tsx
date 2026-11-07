import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL, LegalPage, type LegalSection } from "@/components/legal-page";

export const metadata: Metadata = { title: `Terms & Conditions · ${LEGAL.product}` };

const sections: LegalSection[] = [
  {
    id: "acceptance", title: "Acceptance of these terms",
    body: <p>By creating an account or using {LEGAL.product} (the “Service”), you agree to these Terms &amp; Conditions and to our <Link href="/privacy">Privacy Policy</Link>. If you do not agree, do not use the Service.</p>,
  },
  {
    id: "service", title: "The Service",
    body: (
      <>
        <p>{LEGAL.product} is a retrieval-augmented question-answering tool. It searches documents you upload, the public web and tools you connect, then uses large language models to write answers with citations.</p>
        <p>We may change, suspend or discontinue any part of the Service at any time.</p>
      </>
    ),
  },
  {
    id: "accounts", title: "Accounts",
    body: (
      <ul>
        <li>You must give accurate information when you register and keep it up to date.</li>
        <li>You are responsible for keeping your password secure and for all activity under your account.</li>
        <li>You may sign in with an email and password or with Google. If you use Google, Google’s terms also apply to that sign-in.</li>
        <li>Tell us promptly at <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> if you suspect unauthorized use of your account.</li>
      </ul>
    ),
  },
  {
    id: "content", title: "Your content",
    body: (
      <>
        <p>You keep ownership of the documents, questions and other material you submit (“Your Content”). You grant us a limited licence to store, index and process Your Content only to operate the Service for you.</p>
        <p>You confirm that you have the right to upload Your Content and that it does not infringe anyone else’s rights or break any law.</p>
      </>
    ),
  },
  {
    id: "acceptable-use", title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for anything illegal, harmful, fraudulent or abusive.</li>
          <li>Upload malware, or content you are not allowed to share (including others’ personal data without a lawful basis).</li>
          <li>Try to break, overload, reverse-engineer or bypass the security or rate limits of the Service.</li>
          <li>Use the Service to generate content that harasses, defames or discriminates against others.</li>
          <li>Scrape or resell the Service without our written permission.</li>
        </ul>
      </>
    ),
  },
  {
    id: "ai-output", title: "AI-generated answers",
    body: (
      <>
        <p>Answers are produced automatically by language models and may be incomplete, out of date or wrong, even when citations are shown. Always check important information against the original sources.</p>
        <p>The Service does not provide legal, medical, financial or other professional advice. You are responsible for how you use any output.</p>
      </>
    ),
  },
  {
    id: "third-parties", title: "Third-party services",
    body: <p>The Service relies on third parties, such as language-model providers, web search and tools you connect through the Model Context Protocol (MCP). Their availability and terms are outside our control, and we are not responsible for their content or practices.</p>,
  },
  {
    id: "termination", title: "Suspension and termination",
    body: <p>You may stop using the Service and ask us to delete your account at any time. We may suspend or close accounts that break these terms or put the Service or other users at risk.</p>,
  },
  {
    id: "disclaimer", title: "Disclaimers and limitation of liability",
    body: (
      <>
        <p>The Service is provided “as is” and “as available”, without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement.</p>
        <p>To the fullest extent permitted by law, we are not liable for any indirect, incidental, special or consequential damages, or for any loss of data, profits or goodwill, arising from your use of the Service.</p>
      </>
    ),
  },
  {
    id: "changes", title: "Changes to these terms",
    body: <p>We may update these terms from time to time. We will change the “Last updated” date above and, for significant changes, notify you in the app. Continuing to use the Service after an update means you accept the new terms.</p>,
  },
  {
    id: "contact", title: "Contact",
    body: <p>Questions about these terms can be sent to <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.</p>,
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions"
      intro={<p>Please read these terms carefully. They set out the rules for using {LEGAL.product} and what you can expect from us.</p>}
      sections={sections}
    />
  );
}
