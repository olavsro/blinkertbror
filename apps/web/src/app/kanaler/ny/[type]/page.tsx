/**
 * Skjemaet for å koble til en ny kilde.
 *
 * Én side for alle kanaltypene, drevet av `channel-forms.ts`. Rekkefølgen på
 * sida er valgt bevisst: hva du får ut av det, så hva du bør vite FØR du
 * begynner, og først da feltene. Advarslene om banktilgang og portalvilkår
 * hører hjemme over skjemaet, ikke i liten skrift under det.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { createChannel } from "@/lib/channel-actions";
import { formFor } from "@/lib/channel-forms";
import { currentUser } from "@/lib/data";
import { PresetPicker } from "./preset-picker";

export const dynamic = "force-dynamic";

export default async function NewChannelPage({ params }: { params: Promise<{ type: string }> }) {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  const { type } = await params;
  const form = formFor(type);
  if (!form) notFound();

  return (
    <>
      <p className="small muted">
        <Link href="/kanaler">← Alle kilder</Link>
      </p>
      <h1>{form.title}</h1>
      <p className="lede">{form.promise}</p>

      {form.unavailable ? (
        <div className="notice">
          <strong>Ikke klar ennå.</strong>
          <div style={{ marginTop: 4 }}>{form.unavailable}</div>
        </div>
      ) : null}

      {form.before?.length ? (
        <div className="panel">
          <strong>Dette bør du vite først</strong>
          <ul className="before-list">
            {form.before.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {form.fields.length === 0 ? (
        <div className="panel">
          <p>Denne trenger ikke noe oppsett. Du kan begynne å laste opp med en gang.</p>
          <Link href="/last-opp">
            <button type="button" className="primary">
              Gå til opplasting
            </button>
          </Link>
        </div>
      ) : (
        <form action={createChannel} className="panel setup-form">
          <input type="hidden" name="type" value={form.type} />

          {form.presets ? <PresetPicker presets={form.presets} /> : null}

          <label className="field">
            <span className="field-label">Navn</span>
            <span className="field-help">Bare for din egen del, så du kjenner den igjen i lista.</span>
            <input type="text" name="name" defaultValue={form.title} />
          </label>

          {form.fields.map((field) => (
            <label className="field" key={field.name}>
              <span className="field-label">
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
              </span>
              {field.help ? <span className="field-help">{field.help}</span> : null}
              <input
                type={field.type === "checkbox" ? "checkbox" : field.type}
                name={field.name}
                required={field.required}
                placeholder={field.placeholder}
                defaultValue={field.defaultValue}
                // Passordfelter skal aldri fylles ut av nettleseren med en
                // lagret verdi fra et annet nettsted.
                autoComplete={field.secret ? "new-password" : "off"}
                data-field={field.name}
              />
              {field.secret ? (
                <span className="field-help secret-note">
                  🔒 Lagres kryptert. Vi viser den aldri igjen, og den kommer aldri med i logger.
                </span>
              ) : null}
            </label>
          ))}

          <div className="setup-actions">
            <button type="submit" className="primary" disabled={Boolean(form.unavailable)}>
              {form.twoStep ? "Fortsett" : "Koble til"}
            </button>
            <Link href="/kanaler" className="small muted">
              Avbryt
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
