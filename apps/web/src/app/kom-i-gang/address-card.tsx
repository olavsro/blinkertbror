"use client";

/**
 * Den ENESTE klientkomponenten i hele appen.
 *
 * To ting krever den, og begge er noe brukeren merker med en gang:
 *  - En kopier-knapp. Å be folk markere en e-postadresse med musa og trykke
 *    Cmd+C er nettopp den slags friksjon veiviseren finnes for å fjerne.
 *  - Mens vi venter på den første kvitteringen, skal siden oppdatere seg selv.
 *    Ellers sitter brukeren og lurer på om det virket, og trykker refresh.
 *
 * Resten av appen er serverrendret uten klientkode, og det skal den fortsette
 * å være.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function AddressCard({ address, waiting }: { address: string; waiting: boolean }) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Sjekker om det har kommet noe, hvert femte sekund - men bare mens vi
  // faktisk venter. Er kvitteringen kommet, slutter vi å spørre.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [waiting, router]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Utrygg kontekst eller nektet tilgang. Da får brukeren markere selv -
      // adressen står synlig uansett, så ingenting er tapt.
      setCopied(false);
    }
  }

  return (
    <div className="address-box">
      <code className="address-value">{address}</code>
      <button type="button" onClick={copy} className={copied ? "primary" : ""}>
        {copied ? "Kopiert ✓" : "Kopier"}
      </button>
    </div>
  );
}
