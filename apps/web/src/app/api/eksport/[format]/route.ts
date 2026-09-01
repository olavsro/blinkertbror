/**
 * Eksport til regnskapsfører: SAF-T (XML), full CSV og enkel CSV.
 *
 * Ruta nekter å levere en SAF-T-fil som ikke går i null. En ubalansert fil
 * blir avvist av mottakeren uansett, og da er det bedre å si fra her enn å
 * la brukeren finne det ut i dialog med regnskapsføreren sin.
 */
import { NextResponse } from "next/server";
import { getDb } from "@qbikk/db";
import {
  buildSaftXml,
  checkBalanced,
  exportFilename,
  loadCompany,
  loadVouchersForExport,
  toAccountantCsv,
  toSimpleCsv,
} from "@qbikk/export";
import { requireUser } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ format: string }> },
): Promise<NextResponse> {
  const { format } = await params;
  const year = Number(new URL(request.url).searchParams.get("ar")) || new Date().getFullYear();

  const user = await requireUser();
  const db = getDb();
  const [company, vouchers] = await Promise.all([
    loadCompany(db, user.id),
    loadVouchersForExport(db, user.id, year),
  ]);

  if (vouchers.length === 0) {
    return NextResponse.json({ ok: false, error: `Ingen bilag i ${year}` }, { status: 404 });
  }

  if (format === "saft") {
    const balance = checkBalanced(vouchers);
    if (!balance.balanced) {
      // Skal aldri skje - postingsFor() bygger alltid balanserte sett. Skjer
      // det likevel, er det en feil hos oss, og filen skal ikke ut.
      return NextResponse.json(
        {
          ok: false,
          error: "Eksporten går ikke i null - dette er en feil i Qbikk, ikke i bilagene dine.",
          debit: balance.debit / 100,
          credit: balance.credit / 100,
        },
        { status: 500 },
      );
    }

    return new NextResponse(buildSaftXml({ company, year, vouchers }), {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFilename(company, year, "xml")}"`,
      },
    });
  }

  if (format === "csv" || format === "enkel") {
    const body = format === "csv" ? toAccountantCsv(vouchers) : toSimpleCsv(vouchers);
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFilename(company, year, "csv")}"`,
      },
    });
  }

  return NextResponse.json({ ok: false, error: `Ukjent format: ${format}` }, { status: 400 });
}
