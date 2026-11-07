import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL, LegalPage, type LegalSection } from "@/components/legal-page";

export const metadata: Metadata = { title: `Privacy Policy · ${LEGAL.product}` };

const sections: LegalSection[] = [
  {
    id: "collect", title: "Information we collect",
    body: (
      <>
        <p><strong>Account information.</strong> Your name and email address. If you register with a password, we store only a salted bcrypt hash of it, never the password itself. If you sign in with Google, we receive your name, email address and profile picture from Google.</p>
        <p><strong>Content you provide.</strong> Documents you upload, the questions you ask, and the answers and conversation history the Service produces.</p>
        <p><strong>Usage and technical data.</strong> Sign-in times, IP address (used for rate limiting), and logs of agent and tool activity used to debug and evaluate answer quality.</p>
      </>
    ),
  },
  {
    id: "use", title: "How we use your information",
    body: (
      <ul>
        <li>To create and secure your account and keep you signed in.</li>
        <li>To index your documents and answer your questions.</li>
        <li>To remember conversation context you choose to keep (the Memory feature).</li>
        <li>To monitor, debug and improve the reliability and quality of the Service.</li>
        <li>To prevent abuse and enforce our <Link href="/terms">Terms &amp; Conditions</Link>.</li>
      </ul>
    ),
  },
  {
    id: "sharing", title: "How information is shared",
    body: (
      <>
        <p>We do not sell your personal information. We share data only with the service providers needed to run the Service:</p>
        <ul>
          <li><strong>Language-model providers</strong> (for example Groq): your question and relevant excerpts of your documents are sent to generate an answer.</li>
          <li><strong>Web search</strong> (for example DuckDuckGo): search queries derived from your question may be sent when web research is used.</li>
          <li><strong>Tools you connect</strong> through MCP: they receive the requests the agents make on your behalf.</li>
          <li><strong>Hosting and database</strong> (MongoDB Atlas): stores your account record.</li>
          <li><strong>Google</strong>: if you choose Google sign-in.</li>
        </ul>
        <p>We may also disclose information if required by law or to protect the rights and safety of our users or the Service.</p>
      </>
    ),
  },
  {
    id: "cookies", title: "Cookies",
    body: <p>We use a small number of essential cookies to keep you signed in and to protect sign-in forms against cross-site request forgery. We also store your theme and sidebar preferences in your browser’s local storage. We do not use advertising or third-party tracking cookies.</p>,
  },
  {
    id: "retention", title: "Data retention",
    body: <p>We keep your account information while your account is active. Uploaded documents and conversations stay until you delete them in the app or ask us to delete your account. Logs are kept only as long as needed for debugging and security.</p>,
  },
  {
    id: "security", title: "Security",
    body: <p>Passwords are hashed with bcrypt, sessions use signed and encrypted tokens, and connections to our database are encrypted in transit. No system is perfectly secure, so please use a strong, unique password.</p>,
  },
  {
    id: "rights", title: "Your rights and choices",
    body: (
      <>
        <p>Depending on where you live, you may have the right to access, correct, export or delete your personal information, or to object to certain processing. You can delete documents and chats yourself in the app. For anything else, email <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.</p>
      </>
    ),
  },
  {
    id: "children", title: "Children",
    body: <p>The Service is not intended for children under 13 (or the minimum age in your country), and we do not knowingly collect their personal information.</p>,
  },
  {
    id: "changes", title: "Changes to this policy",
    body: <p>We may update this policy from time to time. We will change the “Last updated” date above and, for significant changes, notify you in the app.</p>,
  },
  {
    id: "contact", title: "Contact",
    body: <p>Questions or requests about your privacy can be sent to <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.</p>,
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={<p>This policy explains what information {LEGAL.product} collects, how we use it, and the choices you have.</p>}
      sections={sections}
    />
  );
}
