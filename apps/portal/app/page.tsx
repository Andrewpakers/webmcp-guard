import { redirect } from "next/navigation";

/** The portal has no dashboard of its own — staff land on the patient roster. */
export default function Home() {
  redirect("/patients");
}
