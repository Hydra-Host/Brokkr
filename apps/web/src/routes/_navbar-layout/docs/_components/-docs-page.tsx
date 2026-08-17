import { cn } from '@repo/ui/utils';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

interface Heading {
  id: string;
  text: string;
  level: number;
  children?: Heading[];
}

interface DocPageProps {
  children: React.ReactNode;
  className?: string;
}

interface HeadingProps {
  children: React.ReactNode;
  className?: string;
}

interface SectionTitleProps {
  children: React.ReactNode;
  className?: string;
}

interface PageTitleProps {
  children: React.ReactNode;
  className?: string;
}

interface ContentProps {
  children: React.ReactNode;
  className?: string;
}

interface FooterProps {
  children: React.ReactNode;
  className?: string;
}

interface PreviousLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

interface NextLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
}

const DocPage = ({ children, className = '' }: DocPageProps) => {
  return <div className={className}>{children}</div>;
};

const Heading = ({ children, className = '' }: HeadingProps) => {
  return <header className={cn('border-border flex flex-col gap-2 border-b pb-8', className)}>{children}</header>;
};

const SectionTitle = ({ children, className = '' }: SectionTitleProps) => {
  return <div className={cn('text-primary text-sm font-semibold tracking-wide', className)}>{children}</div>;
};

const PageTitle = ({ children, className = '' }: PageTitleProps) => {
  return <h1 className={cn('text-foreground text-3xl font-bold', className)}>{children}</h1>;
};

const Content = ({ children, className = '' }: ContentProps) => {
  return (
    <main
      className={cn(
        'mt-8 max-w-4xl',
        '[&_h1]:text-foreground [&_h1]:mt-12 [&_h1]:mb-8 [&_h1]:text-3xl [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-tight',
        '[&_h2]:text-foreground [&_h2]:mt-10 [&_h2]:mb-6 [&_h2]:text-2xl [&_h2]:leading-tight [&_h2]:font-semibold [&_h2]:tracking-tight',
        '[&_h3]:text-foreground [&_h3]:mt-8 [&_h3]:mb-4 [&_h3]:text-xl [&_h3]:leading-snug [&_h3]:font-semibold [&_h3]:tracking-tight',
        '[&_h4]:text-foreground [&_h4]:mt-6 [&_h4]:mb-3 [&_h4]:text-lg [&_h4]:leading-snug [&_h4]:font-semibold',
        '[&_p]:text-muted-foreground [&_p]:mb-6 [&_p]:text-base [&_p]:leading-loose [&_p]:tracking-wide',
        '[&_strong]:text-foreground [&_strong]:font-semibold',
        '[&_em]:text-muted-foreground [&_em]:italic',
        '[&_li]:text-muted-foreground [&_li]:mb-2 [&_li]:leading-loose [&_li]:tracking-wide [&_ul]:mb-6 [&_ul]:pl-8',
        '[&_ol]:mb-6 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-8',
        '[&_ul]:list-disc [&_ul]:space-y-2',
        '[&_code]:border-border [&_code]:bg-muted [&_code]:rounded [&_code]:border [&_code]:px-2 [&_code]:py-1 [&_code]:font-mono [&_code]:text-sm',
        '[&_pre]:border-border [&_pre]:bg-muted [&_pre]:mb-8 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-6 [&_pre]:leading-relaxed [&_pre]:shadow-lg',
        '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm',
        '[&_a]:text-primary [&_a]:font-medium [&_a]:tracking-wide [&_a]:no-underline [&_a]:hover:underline',
        '[&_blockquote]:border-primary [&_blockquote]:text-muted-foreground [&_blockquote]:my-8 [&_blockquote]:border-l-4 [&_blockquote]:py-2 [&_blockquote]:pl-6 [&_blockquote]:text-lg [&_blockquote]:leading-loose [&_blockquote]:tracking-wide [&_blockquote]:italic',
        '[&_table]:mb-8 [&_table]:w-full [&_table]:border-collapse [&_table]:border-spacing-0',
        '[&_th]:border-border [&_th]:bg-muted [&_th]:text-foreground [&_th]:border [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_th]:font-semibold [&_th]:tracking-wide',
        '[&_td]:border-border [&_td]:text-muted-foreground [&_td]:border [&_td]:px-4 [&_td]:py-3 [&_td]:leading-relaxed',
        className,
      )}
    >
      {children}
    </main>
  );
};

const Footer = ({ children, className = '' }: FooterProps) => {
  return (
    <footer className={cn('border-border mt-16 border-t pt-8', 'flex items-center justify-between', className)}>
      {children}
    </footer>
  );
};

const PreviousLink = ({ href, children, className = '' }: PreviousLinkProps) => {
  return (
    <Link to={href} className={cn('group flex flex-col gap-1', 'transition-colors duration-200', className)}>
      <span className="text-foreground text-sm font-bold">Previous</span>
      <div className="flex items-center gap-2">
        <ArrowLeft className="text-muted-foreground group-hover:text-foreground h-4 w-4 transition-colors" />
        <span className="text-muted-foreground group-hover:text-foreground text-sm font-medium transition-colors">
          {children}
        </span>
      </div>
    </Link>
  );
};

const NextLink = ({ href, children, className = '' }: NextLinkProps) => {
  return (
    <Link to={href} className={cn('group flex flex-col items-end gap-1', 'transition-colors duration-200', className)}>
      <span className="text-foreground text-sm font-bold">Next</span>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground group-hover:text-foreground text-sm font-medium transition-colors">
          {children}
        </span>
        <ArrowRight className="text-muted-foreground group-hover:text-foreground h-4 w-4 transition-colors" />
      </div>
    </Link>
  );
};

function getScrollContainer(): HTMLElement | null {
  return document.querySelector('[class*="overflow-y-auto"]');
}

const DocsPageTableOfContents = ({ className }: { className?: string }) => {
  const location = useLocation();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const isAtBottomRef = useRef(false);

  useEffect(() => {
    setActiveId('');

    const extractHeadings = () => {
      const contentElement = document.querySelector('main');
      if (!contentElement) {
        setHeadings([]);
        return;
      }

      const headingElements = contentElement.querySelectorAll('h2, h3');
      const headingsList: Heading[] = [];
      let currentH2: Heading | null = null;

      headingElements.forEach((heading) => {
        const htmlHeading = heading as HTMLElement;
        const level = parseInt(htmlHeading.tagName.charAt(1));
        const text = htmlHeading.textContent || '';
        let id = htmlHeading.id;

        if (!id) {
          id = text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

          let uniqueId = id;
          let counter = 1;
          while (document.getElementById(uniqueId) && document.getElementById(uniqueId) !== htmlHeading) {
            uniqueId = `${id}-${counter}`;
            counter++;
          }

          htmlHeading.setAttribute('id', uniqueId);
          id = uniqueId;
        }

        const headingItem: Heading = { id, text, level };

        if (level === 2) {
          headingItem.children = [];
          headingsList.push(headingItem);
          currentH2 = headingItem;
        } else if (level === 3 && currentH2) {
          currentH2.children!.push(headingItem);
        }
      });

      setHeadings(headingsList);
    };

    extractHeadings();

    const timeoutId = setTimeout(extractHeadings, 100);

    const observer = new MutationObserver(() => {
      extractHeadings();
    });

    const contentElement = document.querySelector('main');
    if (contentElement) {
      observer.observe(contentElement, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [location.pathname]);

  useEffect(() => {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;

    const getAllHeadingIds = (headings: Heading[]): string[] => {
      const ids: string[] = [];
      headings.forEach((heading) => {
        ids.push(heading.id);
        if (heading.children) {
          ids.push(...heading.children.map((child) => child.id));
        }
      });
      return ids;
    };

    const allHeadingIds = getAllHeadingIds(headings);
    const headingElements = allHeadingIds.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];

    if (headingElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isAtBottomRef.current) return;

        const visibleEntries = entries.filter((entry) => entry.isIntersecting);

        if (visibleEntries.length > 0) {
          const topEntry = visibleEntries.reduce((prev, current) => {
            return prev.boundingClientRect.top < current.boundingClientRect.top ? prev : current;
          });

          setActiveId(topEntry.target.id);
        }
      },
      {
        root: scrollContainer,
        rootMargin: '-100px 0% -80% 0%',
        threshold: 0,
      },
    );

    headingElements.forEach((element) => {
      observer.observe(element);
    });

    let scrollTimeout: ReturnType<typeof setTimeout>;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const { scrollHeight, scrollTop, clientHeight } = scrollContainer;

        if (scrollHeight - scrollTop - clientHeight < 200) {
          isAtBottomRef.current = true;
          if (allHeadingIds.length > 0) {
            setActiveId(allHeadingIds[allHeadingIds.length - 1]);
          }
        } else {
          isAtBottomRef.current = false;
        }
      }, 50);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

    handleScroll();

    return () => {
      clearTimeout(scrollTimeout);
      observer.disconnect();
      scrollContainer.removeEventListener('scroll', handleScroll);
    };
  }, [headings]);

  const handleClick = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;

    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const offset = elementRect.top - containerRect.top + scrollContainer.scrollTop - 24;

    scrollContainer.scrollTo({
      top: offset,
      behavior: 'smooth',
    });

    setActiveId(id);
  };

  if (headings.length === 0) {
    return null;
  }

  return (
    <div className={cn('sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto', className)}>
      <nav className="space-y-2">
        <p className="text-foreground mb-4 text-sm font-bold">On this page</p>
        <ul className="space-y-1">
          {headings.map((heading) => (
            <li key={heading.id}>
              <button
                onClick={() => handleClick(heading.id)}
                className={cn(
                  'hover:text-foreground block w-full text-left text-sm font-medium transition-colors duration-200',
                  'border-l-2 border-transparent py-1 pl-3',
                  activeId === heading.id ? 'text-primary border-primary' : 'text-muted-foreground border-transparent',
                )}
              >
                {heading.text}
              </button>
              {heading.children && heading.children.length > 0 && (
                <ul className="mt-1 ml-4 space-y-1">
                  {heading.children.map((child) => (
                    <li key={child.id}>
                      <button
                        onClick={() => handleClick(child.id)}
                        className={cn(
                          'hover:text-foreground block w-full text-left text-xs transition-colors duration-200',
                          'border-l-2 border-transparent py-1 pl-3',
                          activeId === child.id
                            ? 'text-primary border-primary'
                            : 'text-muted-foreground border-transparent',
                        )}
                      >
                        {child.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
};

DocPage.Heading = Heading;
DocPage.SectionTitle = SectionTitle;
DocPage.PageTitle = PageTitle;
DocPage.Content = Content;
DocPage.Footer = Footer;
DocPage.PreviousLink = PreviousLink;
DocPage.NextLink = NextLink;
DocPage.TableOfContents = DocsPageTableOfContents;

export { DocPage };
