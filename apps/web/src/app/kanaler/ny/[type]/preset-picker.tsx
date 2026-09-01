"use client";

/**
 * «Hvor har du e-posten din?» - fyller ut serveradresse og port automatisk.
 *
 * De aller fleste bruker Gmail eller Outlook, og ingen av dem vet hva
 * `imap.gmail.com` er eller hvorfor porten skal være 993. Å be dem finne det
 * ut selv er den enkleste måten å miste dem på i dette skjemaet.
 *
 * Klientkomponent fordi den må skrive inn i felter som allerede står på sida.
 * Feltene beholder `name`, så skjemaet virker likt om JavaScript er av - da
 * må brukeren bare fylle inn serveradressen selv.
 */
import { useState } from "react";
import type { PresetSpec } from "@/lib/channel-forms";

export function PresetPicker({
  presets,
}: {
  presets: { field: string; label: string; options: PresetSpec[] };
}) {
  const [chosen, setChosen] = useState<string | null>(null);

  function apply(preset: PresetSpec): void {
    setChosen(preset.key);
    for (const [name, value] of Object.entries(preset.values)) {
      const input = document.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
      if (!input) continue;
      input.value = value;
      // React ser ikke direkte DOM-skriving. Uten dette eventet ville en
      // kontrollert komponent skrevet verdien tilbake ved neste render.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return (
    <div className="field">
      <span className="field-label">{presets.label}</span>
      <div className="preset-row">
        {presets.options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`preset${chosen === option.key ? " chosen" : ""}`}
            onClick={() => apply(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
