import { MONO_FONT_CSS_URL, REDOC_SCRIPT_URL, SWAGGER_CSS_URL, SWAGGER_SCRIPT_URL } from './docs-assets';
import { paletteFor, type Palette } from './theme-palette';

// redoc's sidebar footer loads a redocly logo off their cdn; nothing else on these pages wants a
// remote image, so an img-src rule keeps the page hermetic without constraining scripts or styles.
const IMG_ONLY_CSP = `<meta http-equiv="Content-Security-Policy" content="img-src 'self' data:">`;

export function getRedocHtml(specUrl = '/api/swagger-json', theme?: string) {
  const t = paletteFor(theme);
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Brokkr Local — Lab API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${IMG_ONLY_CSP}
    <link rel="stylesheet" href="${MONO_FONT_CSS_URL}">
    <style>
      body {
        margin: 0;
        padding: 0;
        background-color: ${t.bg};
        color: ${t.textPrimary};
      }
      * { border-radius: 0 !important; }
      .redoc-wrap { background-color: ${t.bg}; }
      [data-section-id],
      div[class*="menu-content"],
      div[class*="api-content"] {
        background-color: ${t.bg} !important;
      }
      .token.string { color: ${t.statusOnline} !important; }
      .token.number { color: ${t.statusInfo} !important; }
      .token.boolean { color: ${t.statusWarning} !important; }
      .token.property { color: ${t.accent} !important; }
      span[class*="token property"] { color: ${t.accent} !important; }
      .required { color: ${t.statusOffline} !important; }

      /* Response schema backgrounds */
      div[class*="response-schema"],
      div[class*="response-schema"] div {
        background-color: ${t.bg} !important;
      }
      div[class*="response-schema"] span {
        background-color: transparent !important;
      }
      div[class*="response-schema"] h5,
      div[class*="response-schema"] p,
      div[class*="response-schema"] span {
        color: ${t.textPrimary} !important;
      }

      h5[class*="sc-"],
      h5[class*="sc-"] > span[class*="sc-"] {
        color: ${t.textPrimary} !important;
      }
      span[class*="property-name"] { color: ${t.accent} !important; }

      /* HTTP method badges - sharp terminal look */
      [class*="http-verb"] {
        border-radius: 0 !important;
        font-family: ${t.font} !important;
        text-transform: uppercase !important;
        letter-spacing: 0.05em;
      }

      /* Request samples heading and tab text. NOTE: was set to ${`\${t.bg}`} which
         matched the panel background and rendered the labels invisible. */
      li[class*="react-tabs__tab"],
      li[class*="tab-"] {
        color: ${t.textPrimary} !important;
        opacity: 0.7;
      }
      li[class*="react-tabs__tab--selected"],
      li[class*="tab-"][class*="active"] {
        color: ${t.accent} !important;
        opacity: 1;
      }

      /* Deprecated badge */
      span[type="warning"] {
        background-color: ${t.statusOffline} !important;
        border-color: ${t.statusOffline} !important;
        color: #fff !important;
      }

      /* Scrollbar - minimal */
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: ${t.bg}; }
      ::-webkit-scrollbar-thumb { background: ${t.border}; }
      ::-webkit-scrollbar-thumb:hover { background: ${t.accentDim}; }
    </style>
  </head>
  <body>
    <div id="redoc-container"></div>
    <script src="${REDOC_SCRIPT_URL}"></script>
    <script>
      Redoc.init(
        ${JSON.stringify(specUrl)},
        {
          theme: {
            colors: {
              primary: { main: '${t.accent}' },
              success: { main: '${t.statusOnline}' },
              error: { main: '${t.statusOffline}' },
              warning: { main: '${t.statusWarning}' },
              text: {
                primary: '${t.textPrimary}',
                secondary: '${t.textMuted}'
              },
              http: {
                get: '#60a5fa',
                post: '${t.statusOnline}',
                put: '${t.statusWarning}',
                patch: '${t.accent}',
                delete: '${t.statusOffline}',
                options: '${t.textMuted}',
                head: '${t.textMuted}'
              }
            },
            schema: {
              nestedBackground: '${t.bgSecondary}',
              typeNameColor: '${t.accent}',
              typeTitleColor: '${t.textPrimary}',
              requireLabelColor: '${t.statusOffline}',
              labelsTextSize: '0.8em',
              nestingSpacing: '1em',
              arrow: { size: '1em', color: '${t.textMuted}' }
            },
            sidebar: {
              backgroundColor: '${t.bgSidebar}',
              textColor: '${t.textMuted}',
              activeTextColor: '${t.accent}',
              groupItems: { activeBackgroundColor: '${t.bg}', activeTextColor: '${t.accent}' },
              level1Items: { activeBackgroundColor: '${t.bg}', activeTextColor: '${t.accent}' },
              arrow: { size: '1em', color: '${t.textDim}' }
            },
            typography: {
              fontSize: '14px',
              lineHeight: '1.6em',
              fontFamily: ${JSON.stringify(t.font)},
              headings: {
                fontFamily: ${JSON.stringify(t.font)},
                fontWeight: '600',
                color: '${t.textPrimary}'
              },
              code: {
                fontSize: '13px',
                fontFamily: ${JSON.stringify(t.font)},
                color: '${t.textPrimary}',
                backgroundColor: '${t.codeBg}',
                wrap: true
              },
              links: { color: '${t.accent}', hover: '${t.accentDim}' }
            },
            rightPanel: {
              backgroundColor: '${t.bgSecondary}',
              textColor: '${t.textPrimary}',
              servers: {
              overlay: { backgroundColor: '${t.bg}', textColor: '${t.textPrimary}' },
              url: { backgroundColor: '${t.bgSecondary}' }
            }
            },
            codeBlock: {
              backgroundColor: '${t.codeBg}'
            }
          },
          hideDownloadButton: false,
          expandResponses: '200,201',
          sortTagsAlphabetically: true,
          sortOperationsAlphabetically: true,
          nativeScrollbars: true
        },
        document.getElementById('redoc-container')
      );
    </script>
  </body>
</html>`;
}

export function getSwaggerCss(t: Palette) {
  return `
  body {
    background-color: ${t.bg};
    color: ${t.textPrimary};
    font-family: ${t.font};
  }
  * { border-radius: 0 !important; }
  .swagger-ui { color: ${t.textPrimary}; font-family: ${t.font}; }
  .swagger-ui .model-toggle,
  .swagger-ui span.model-toggle,
  .swagger-ui span[class*="model-toggle"],
  .swagger-ui div[class*="model-box"] span[class*="model-toggle"],
  .swagger-ui div[class*="model"] span[class*="model-toggle"] {
    color: ${t.textPrimary} !important;
  }
  .swagger-ui .col_header { color: ${t.textPrimary} !important; }
  .swagger-ui table thead tr th,
  .swagger-ui table thead tr td { color: ${t.textPrimary} !important; }
  .swagger-ui .expand-operation svg,
  .swagger-ui .opblock-summary-control svg,
  .swagger-ui .arrow { fill: ${t.textPrimary} !important; }
  .swagger-ui .opblock-tag { color: ${t.textPrimary} !important; border-bottom-color: ${t.accent}; }
  .swagger-ui .opblock-tag-section { color: ${t.textPrimary}; }
  .swagger-ui .opblock-tag a { color: ${t.textPrimary} !important; }
  .swagger-ui .opblock-tag small { color: ${t.textMuted}; }
  .swagger-ui .info .title,
  .swagger-ui .info h1,
  .swagger-ui .info h2,
  .swagger-ui .info h3,
  .swagger-ui .info h4,
  .swagger-ui .info h5,
  .swagger-ui .info li,
  .swagger-ui .info p,
  .swagger-ui .info table { color: ${t.textPrimary} !important; }
  .swagger-ui .opblock .opblock-summary-description,
  .swagger-ui .opblock .opblock-summary-operation-id,
  .swagger-ui .opblock .opblock-summary-path,
  .swagger-ui .opblock .opblock-summary-path__deprecated { color: ${t.textPrimary}; }
  .swagger-ui .opblock { background-color: ${t.bgSecondary}; border-color: ${t.border}; }
  .swagger-ui .opblock.opblock-get { background-color: rgba(96, 165, 250, 0.08); }
  .swagger-ui .opblock.opblock-post { background-color: rgba(111, 236, 79, 0.08); }
  .swagger-ui .opblock.opblock-delete { background-color: rgba(255, 56, 59, 0.08); }
  .swagger-ui .opblock.opblock-put { background-color: rgba(251, 212, 36, 0.08); }
  .swagger-ui .opblock.opblock-patch { background-color: rgba(255, 220, 117, 0.08); }
  .swagger-ui .scheme-container { background-color: ${t.bg}; }
  .swagger-ui .btn { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; border-color: ${t.accent}; }
  .swagger-ui select { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; border-color: ${t.accent}; }
  .swagger-ui select option { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; }
  select, option, optgroup { background-color: ${t.bgSecondary} !important; color: ${t.textPrimary} !important; }
  [role="listbox"], [role="option"],
  .select-container ul, .select-container li, .select-container .options {
    background-color: ${t.bgSecondary} !important; color: ${t.textPrimary} !important;
  }
  .swagger-ui .parameter__name, .swagger-ui .parameter__type { color: ${t.accent}; }
  .swagger-ui .parameter__extension, .swagger-ui .parameter__in { color: ${t.textMuted}; }
  .swagger-ui input[type=text] { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; }
  .swagger-ui textarea { background-color: ${t.bgSecondary} !important; color: ${t.textPrimary} !important; }
  .swagger-ui .topbar { background-color: ${t.bg}; }
  .swagger-ui .model { color: ${t.textPrimary}; }
  .swagger-ui .model-title { color: ${t.textPrimary}; }
  .swagger-ui .model .property { color: ${t.accent}; }
  .swagger-ui .model .property.primitive { color: ${t.statusOnline}; }
  .swagger-ui .prop-type { color: ${t.textMuted}; }
  .swagger-ui .response-col_status { color: ${t.textPrimary}; }
  .swagger-ui .response-col_description { color: ${t.textPrimary}; }
  .swagger-ui .responses-table tbody tr td:first-of-type { color: ${t.textPrimary}; }
  .swagger-ui .tab li { color: ${t.textPrimary}; }
  .swagger-ui .opblock-description-wrapper p { color: ${t.textPrimary}; }
  .swagger-ui .opblock-external-docs-wrapper { color: ${t.textPrimary}; }
  .swagger-ui .renderedMarkdown { color: ${t.textPrimary}; }

  div[class*="response-schema"],
  div[class*="response-schema"] div { background-color: ${t.bg} !important; }
  div[class*="response-schema"] span { background-color: transparent !important; }
  div[class*="response-schema"] h5,
  div[class*="response-schema"] p,
  div[class*="response-schema"] span { color: ${t.textPrimary} !important; }

  .required { color: ${t.statusOffline} !important; }

  .swagger-ui .models h4, .swagger-ui .models h5,
  .swagger-ui .models .model-title, .swagger-ui .models .model-toggle,
  .swagger-ui .models .model-box, .swagger-ui .models .model-box *,
  .swagger-ui .models .model-name, .swagger-ui .models .model-container,
  .swagger-ui .models .model-schema, .swagger-ui .models .arrow,
  .swagger-ui .models svg { color: ${t.textPrimary} !important; fill: ${t.textPrimary} !important; }
  .swagger-ui .model-toggle:after { display: none !important; }

  .swagger-ui .dialog-ux .modal-ux { background-color: ${t.bg}; border: 1px solid ${t.accent}; }
  .swagger-ui .dialog-ux .modal-ux-header,
  .swagger-ui .dialog-ux .modal-ux-content,
  .swagger-ui .dialog-ux .modal-ux-header h3 {
    background-color: ${t.bg}; color: ${t.textPrimary}; border-color: ${t.accent};
  }
  .swagger-ui .dialog-ux .modal-ux-header .close-modal { color: ${t.textPrimary}; }
  .swagger-ui .auth-container,
  .swagger-ui .auth-container h1, .swagger-ui .auth-container h2,
  .swagger-ui .auth-container h3, .swagger-ui .auth-container h4,
  .swagger-ui .auth-container h5, .swagger-ui .auth-container h6,
  .swagger-ui .auth-container label, .swagger-ui .auth-container p,
  .swagger-ui .auth-container strong, .swagger-ui .auth-container small {
    color: ${t.textPrimary} !important;
  }
  .swagger-ui .auth-container input[type=text],
  .swagger-ui .auth-container input[type=password] {
    background-color: ${t.bgSecondary}; color: ${t.textPrimary}; border: 1px solid ${t.accent};
  }
  .swagger-ui .auth-btn-wrapper { display: flex; padding: 10px 0; justify-content: flex-end; }
  .swagger-ui .auth-btn-wrapper .btn-done { background-color: ${t.accent}; color: ${t.bg}; border-color: ${t.accent}; }
  .swagger-ui .auth-btn-wrapper .btn-cancel { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; border-color: ${t.accent}; }
  .swagger-ui .auth-btn-wrapper .btn { margin-left: 10px; }
  .swagger-ui .auth-container .logout-btn { background-color: ${t.bgSecondary}; color: ${t.textPrimary}; border-color: ${t.accent}; margin-right: 10px; }
  .swagger-ui .scopes { background-color: ${t.bg}; color: ${t.textPrimary}; }
  .swagger-ui .scopes h2 { color: ${t.textPrimary}; }
`;
}

export function getSwaggerHtml(specUrl = '/api/swagger-json', theme?: string) {
  const t = paletteFor(theme);
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Brokkr Local Lab API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${IMG_ONLY_CSP}
    <link rel="stylesheet" href="${MONO_FONT_CSS_URL}">
    <link rel="stylesheet" href="${SWAGGER_CSS_URL}">
    <style>${getSwaggerCss(t)}</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_SCRIPT_URL}"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
        // swagger-ui otherwise badges the page with an image fetched from validator.swagger.io
        validatorUrl: null,
      });
    </script>
  </body>
</html>`;
}
