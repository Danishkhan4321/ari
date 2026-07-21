type GoogleProduct = "gmail" | "calendar" | "drive" | "docs" | "sheets" | "slides" | "tasks";

// Official Google-hosted product artwork. Keep these as images rather than
// recreating the trademark shapes in Ari's component code.
const officialGoogleLogos: Record<GoogleProduct, string> = {
  gmail: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-64dp/logo_gmail_2020q4_color_2x_web_64dp.png",
  calendar: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v13/web-64dp/logo_calendar_2020q4_color_2x_web_64dp.png",
  drive: "https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/web-64dp/logo_drive_2020q4_color_2x_web_64dp.png",
  docs: "https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v6/web-64dp/logo_docs_2020q4_color_2x_web_64dp.png",
  sheets: "https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v11/web-64dp/logo_sheets_2020q4_color_2x_web_64dp.png",
  slides: "https://fonts.gstatic.com/s/i/productlogos/slides_2020q4/v6/web-64dp/logo_slides_2020q4_color_2x_web_64dp.png",
  tasks: "https://www.gstatic.com/images/branding/productlogos/tasks_2026/v2/web/192px.svg",
};

export function GoogleProductIcon({ product }: { product: GoogleProduct }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- official remote brand asset
    <img
      src={officialGoogleLogos[product]}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={28}
      height={28}
      className="h-7 w-7 object-contain"
    />
  );
}
