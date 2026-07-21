import { notFound } from "next/navigation";
import { features, featureBySlug, allSlugs } from "@/lib/features-data";
import FeatureSlugClient from "./FeatureSlugClient";

export function generateStaticParams() {
  return allSlugs.map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const feature = featureBySlug(params.slug);
  if (!feature) return { title: "Feature not found · Ari" };
  return {
    title: `${feature.title} · Ari`,
    description: feature.overview,
  };
}

export default function FeatureDetailNudge({
  params,
}: {
  params: { slug: string };
}) {
  const feature = featureBySlug(params.slug);
  if (!feature) notFound();

  const related = features
    .filter((f) => f.category === feature.category && f.slug !== feature.slug)
    .slice(0, 3);

  return <FeatureSlugClient feature={feature} related={related} />;
}
