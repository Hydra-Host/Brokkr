import { createFileRoute } from '@tanstack/react-router';

import { ManifestViewer } from '@/components/manifest-viewer';

export const Route = createFileRoute('/layers')({ component: ManifestViewer });
