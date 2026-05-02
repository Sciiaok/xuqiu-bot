import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { config } from "../src/config.js";

const supabase = createClient(
  config.supabase.url,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

async function analyze(waId) {
  // 1. Get contact
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("wa_id", waId)
    .single();

  console.log("=== CONTACT ===");
  console.log(JSON.stringify(contact, null, 2));

  if (!contact) {
    console.log("Contact not found!");
    return;
  }

  // 2. Get conversations
  const { data: conversations } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contact.id)
    .order("started_at", { ascending: true });

  console.log("\n=== CONVERSATIONS (" + conversations.length + ") ===");
  conversations.forEach((c, i) => {
    console.log((i+1) + ". " + c.id.substring(0,8) + " | " + c.started_at + " | msgs:" + c.message_count + " | " + c.status + " | " + (c.closed_reason || ""));
  });

  // 3. Get all leads and messages for each conversation
  for (const conv of conversations) {
    const { data: leads } = await supabase
      .from("leads")
      .select("*")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true });

    console.log("\n=== CONV " + conv.id.substring(0,8) + " - LEADS (" + leads.length + ") ===");
    leads.forEach((l, i) => {
      console.log((i+1) + ". lead_key: " + l.lead_key);
      console.log("   car_model: " + l.car_model);
      console.log("   destination: " + l.destination_country + " / " + l.destination_port);
      console.log("   color_quantity: " + JSON.stringify(l.color_quantity));
      console.log("   inquiry_quality: " + l.inquiry_quality + " | business_value: " + l.business_value);
      console.log("   conversation_intent: " + l.conversation_intent);
      console.log("   intent_summary: " + (l.conversation_intent_summary || "").substring(0, 100));
      console.log("   route: " + l.route);
      console.log("");
    });

    // Get messages
    const { data: messages } = await supabase
      .from("messages")
      .select("id, role, content, sent_at, sent_by")
      .eq("conversation_id", conv.id)
      .order("sent_at", { ascending: true });

    console.log("--- MESSAGES (" + messages.length + ") ---");
    messages.forEach((m, i) => {
      const preview = m.content.substring(0, 120).replace(/\n/g, " ");
      console.log((i+1) + ". [" + m.role + "] " + preview);
    });
  }
}

const waId = process.argv[2] || "251915714156";
analyze(waId).catch(console.error);
