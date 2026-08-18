import { docsBySlug, prevNext, sectionLabel } from '@/lib/docs-manifest';
import { MDXProvider } from '@mdx-js/react';
import { Button } from '@repo/ui/components/button';
import { createFileRoute, Link } from '@tanstack/react-router';
import React, { Suspense, useMemo } from 'react';
import { Note, Warning } from './_components/-callout';
import { DocPage } from './_components/-docs-page';
import { CodeBlock, MdxTable } from './_components/-mdx-blocks';

export const Route = createFileRoute('/_docs/$')({
  component: DocContentPage,
});

/** Internal links navigate through the SPA router; external ones stay anchors. */
function MdxLink({ href = '', children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith('/')) {
    return (
      <Link to={href} {...(rest as Record<string, unknown>)}>
        {children}
      </Link>
    );
  }
  const external = href.startsWith('http');
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} {...rest}>
      {children}
    </a>
  );
}

// Note and Warning are in scope for every docs page; MDX needs no import.
const mdxComponents = { a: MdxLink, pre: CodeBlock, table: MdxTable, Note, Warning };

function DocContentPage() {
  const { _splat } = Route.useParams();
  const slug = _splat ?? '';
  const entry = docsBySlug.get(slug);

  const Content = useMemo(() => (entry ? React.lazy(entry.load) : null), [entry]);

  if (!entry || !Content) {
    return (
      <div className="flex flex-col items-start gap-4 py-24">
        <h1 className="text-foreground text-2xl font-bold">Page not found</h1>
        <p className="text-muted-foreground">No documentation page exists at “{slug}”.</p>
        <Button asChild variant="outline">
          <Link to="/">Back to documentation</Link>
        </Button>
      </div>
    );
  }

  const { prev, next } = prevNext(entry.slug);

  // The docs layout (route.tsx) provides the sidebar and the table-of-contents
  // columns; this route renders only the middle content column.
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.Breadcrumbs section={sectionLabel(entry.section)} title={entry.title} />
        <DocPage.PageTitle>{entry.title}</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <MDXProvider components={mdxComponents}>
          <Suspense fallback={<div className="text-muted-foreground animate-pulse py-12 text-sm">Loading…</div>}>
            <Content />
          </Suspense>
        </MDXProvider>
      </DocPage.Content>

      {(prev || next) && (
        <DocPage.Footer>
          {prev ? <DocPage.PreviousLink href={`/${prev.slug}`}>{prev.title}</DocPage.PreviousLink> : <span />}
          {next ? <DocPage.NextLink href={`/${next.slug}`}>{next.title}</DocPage.NextLink> : <span />}
        </DocPage.Footer>
      )}
    </DocPage>
  );
}
