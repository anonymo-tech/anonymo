import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PublicPage } from './site-chrome';
import styles from './publication.module.css';

const publications = {
  brief: {
    label: 'Business brief',
    file: 'Anonymo-Business-Brief.pdf',
    title: 'Who pays when a model says no?',
    description:
      'How Anonymo turns an eligible model refusal into a second chance to answer, and what that means for its business.',
    photo: 'peek-1',
  },
  whitepaper: {
    label: 'Whitepaper',
    file: 'Anonymo-Whitepaper.pdf',
    title: 'What happens after the first refusal?',
    description:
      'Follow one request through policy checks, a retry, billing and a receipt. Examine the economics of a recovered answer.',
    photo: 'peek-2',
  },
  roadmap: {
    label: 'Commercial roadmap',
    file: 'Anonymo-Commercial-Roadmap.pdf',
    title: 'From a first deposit to a second',
    description:
      'The milestones for paid access, repeat use, routing economics and new capabilities.',
    photo: 'peek-6',
  },
} as const;

type PublicationId = keyof typeof publications;

export function publicationMetadata(id: PublicationId): Metadata {
  const { label, description } = publications[id];
  const title = label + ' | Anonymo';
  const url = 'https://anonymo.tech/' + id;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Anonymo',
      type: 'article',
    },
    twitter: { card: 'summary', title, description },
  };
}

export function Publication({
  id,
  children,
}: {
  id: PublicationId;
  children: ReactNode;
}) {
  const doc = publications[id];
  return (
    <PublicPage wide>
      <article className={styles.publication}>
        <nav className={styles.library} aria-label="Anonymo publications">
          {Object.entries(publications).map(([path, item]) => (
            <Link
              key={path}
              href={'/' + path}
              aria-current={path === id ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
          <Link href="/docs">Developer guide</Link>
        </nav>
        <header className={styles.hero}>
          <div>
            <p className={styles.label}>{doc.label}</p>
            <h1>{doc.title}</h1>
            <div className={styles.byline}>
              <time dateTime="2026-11-20">20 November 2026</time>
              <a href={'/publications/' + doc.file} download>
                Download PDF
              </a>
            </div>
          </div>
          <img
            src={'/mascot/' + doc.photo + '.jpg'}
            alt=""
            width={520}
            height={470}
          />
        </header>
        <div className={styles.paper}>{children}</div>
      </article>
    </PublicPage>
  );
}
