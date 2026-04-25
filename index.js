const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const {
  LIGDICASH_API_KEY,
  LIGDICASH_AUTH_TOKEN,
  LIGDICASH_BASE_URL,
  RENDER_API_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
});

function checkAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");

  if (!token || token !== RENDER_API_TOKEN) {
    return res.status(401).json({ error: "Token Render manquant ou invalide" });
  }

  next();
}

function makeId(prefix) {
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

async function ligdicashFetch(path, options = {}) {
  const url = `${LIGDICASH_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Apikey: LIGDICASH_API_KEY,
      Authorization: `Bearer ${LIGDICASH_AUTH_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

app.get("/", (req, res) => {
  res.send("Backend BekaWiFi OK");
});

/* =========================
   CREATE INVOICE
========================= */

app.post("/create-invoice", limiter, checkAuth, async (req, res) => {
  try {
    const { tarif_id, hotspot_id, description, return_url, cancel_url } = req.body;

    if (!tarif_id) {
      return res.status(400).json({ error: "tarif_id obligatoire" });
    }

    const { data: tarif, error: tarifError } = await supabase
      .from("tarifs")
      .select("prix, actif")
      .eq("id", tarif_id)
      .single();

    if (tarifError || !tarif) {
      return res.status(400).json({ error: "Tarif introuvable" });
    }

    if (tarif.actif === false) {
      return res.status(400).json({ error: "Tarif inactif" });
    }

    const prix = tarif.prix;
    const transactionId = makeId("BEKA");

    const payload = {
      commande: {
        invoice: {
          items: [
            {
              name: description,
              description,
              quantity: 1,
              unit_price: prix,
              total_price: prix,
            },
          ],
          total_amount: prix,
          devise: "XOF",
          description,
          customer: "",
          customer_firstname: "",
          customer_lastname: "",
          customer_email: "",
          external_id: transactionId,
          otp: "",
        },
        store: {
          name: "BekaWiFi",
          website_url: "https://app.bekawifi.com",
        },
        actions: {
          cancel_url,
          return_url: `${return_url}?transaction_id=${transactionId}`,
          callback_url: "https://bekawifi-backend.onrender.com/callback-ligdicash",
        },
        custom_data: [
          {
            keyof_customdata: "transaction_id",
            valueof_customdata: transactionId,
          },
        ],
      },
    };

    const ligdi = await ligdicashFetch(
      "/pay/v01/redirect/checkout-invoice/create",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    if (!ligdi.ok) {
      return res.status(502).json({
        error: "LigdiCash injoignable",
        details: ligdi.data,
      });
    }

    if (ligdi.data.response_code && ligdi.data.response_code !== "00") {
      return res.status(400).json({
        error: "LigdiCash a refusé la facture",
        details: ligdi.data.response_text || ligdi.data,
      });
    }

    const token =
      ligdi.data.token ||
      ligdi.data.invoice_token ||
      ligdi.data.response_data?.token ||
      null;

    const paymentUrl =
      ligdi.data.response_text ||
      ligdi.data.payment_url ||
      ligdi.data.checkout_url ||
      ligdi.data.response_data?.checkout_url ||
      ligdi.data.response_data?.payment_url ||
      null;

    await supabase.from("paiements").insert({
      tarif_id,
      hotspot_id: hotspot_id || null,
      montant: prix,
      statut: "pending",
      ligdicash_token: token,
      custom_transaction_id: transactionId,
    });

    return res.status(200).json({
      payment_url: paymentUrl,
      token,
      transaction_id: transactionId,
    });
  } catch (error) {
    console.error("Erreur create-invoice:", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

/* =========================
   PAYOUT
========================= */

app.post("/payout", limiter, checkAuth, async (req, res) => {
  try {
    const { retrait_id, montant, telephone, nom_destinataire } = req.body;

    if (!retrait_id || !montant || !telephone) {
      return res.status(400).json({ error: "Champs payout manquants" });
    }

    const { data: retrait, error: retraitError } = await supabase
      .from("retraits")
      .select("id, statut, montant")
      .eq("id", retrait_id)
      .single();

    if (retraitError || !retrait) {
      return res.status(400).json({ error: "Retrait introuvable" });
    }

    if (retrait.statut !== "en_attente") {
      return res.status(400).json({ error: "Retrait déjà traité" });
    }

    const transactionId = makeId("PAYOUT");

    const payload = {
      amount: montant,
      customer: telephone,
      firstname: nom_destinataire || "",
      lastname: "",
      external_id: transactionId,
      callback_url: "https://bekawifi-backend.onrender.com/callback-payout",
    };

    const ligdi = await ligdicashFetch("/withdrawal/v01/create", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const payoutToken =
      ligdi.data.token ||
      ligdi.data.payout_token ||
      ligdi.data.response_data?.token ||
      null;

    await supabase.from("payout_attempts").insert({
      retrait_id,
      status: ligdi.ok ? "sent" : "failed",
      request_payload: payload,
      response_payload: ligdi.data,
      http_status: ligdi.status,
      response_code: ligdi.data.response_code || null,
    });

    await supabase
      .from("retraits")
      .update({
        payout_status: ligdi.ok ? "pending" : "failed",
        payout_token: payoutToken,
      })
      .eq("id", retrait_id);

    if (!ligdi.ok) {
      return res.status(502).json({
        success: false,
        error: "LigdiCash injoignable",
        ligdicash_response: ligdi.data,
      });
    }

    if (ligdi.data.response_code && ligdi.data.response_code !== "00") {
      return res.status(200).json({
        success: false,
        transaction_id: transactionId,
        ligdicash_response: ligdi.data,
      });
    }

    return res.status(200).json({
      success: true,
      payout_token: payoutToken,
      transaction_id: transactionId,
      ligdicash_response: ligdi.data,
    });
  } catch (error) {
    console.error("Erreur payout:", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

/* =========================
   CHECK STATUS
========================= */

app.get("/check-status", checkAuth, async (req, res) => {
  try {
    const { transaction_id } = req.query;

    if (!transaction_id) {
      return res.status(400).json({ error: "transaction_id obligatoire" });
    }

    const { data: paiement, error } = await supabase
      .from("paiements")
      .select("id, statut, ligdicash_token, ticket_id")
      .eq("custom_transaction_id", transaction_id)
      .single();

    if (error || !paiement) {
      return res.status(404).json({ error: "Paiement introuvable" });
    }

    let statut = paiement.statut;

    if (statut === "pending" && paiement.ligdicash_token) {
      const ligdi = await ligdicashFetch(
        `/pay/v01/redirect/checkout-invoice/confirm/${paiement.ligdicash_token}`,
        { method: "POST" }
      );

      const ligdiStatus =
        ligdi.data.status ||
        ligdi.data.response_data?.status ||
        ligdi.data.data?.status;

      if (ligdiStatus === "completed") {
        statut = "completed";

        await supabase
          .from("paiements")
          .update({ statut: "completed" })
          .eq("id", paiement.id);
      }
    }

    let ticket = null;

    if (paiement.ticket_id) {
      const { data: ticketData } = await supabase
        .from("tickets")
        .select("username, password, profil, limit_uptime")
        .eq("id", paiement.ticket_id)
        .single();

      ticket = ticketData || null;
    }

    return res.status(200).json({
      transaction_id,
      statut,
      ticket,
    });
  } catch (error) {
    console.error("Erreur check-status:", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

/* =========================
   BALANCE
========================= */

app.get("/balance", checkAuth, async (req, res) => {
  try {
    const ligdi = await ligdicashFetch("/account/v01/balance", {
      method: "GET",
    });

    if (!ligdi.ok) {
      return res.status(502).json({
        error: "Impossible de récupérer le solde LigdiCash",
        details: ligdi.data,
      });
    }

    return res.status(200).json({
      balance:
        ligdi.data.balance ||
        ligdi.data.solde ||
        ligdi.data.response_data?.balance ||
        0,
      currency: "XOF",
      environment: LIGDICASH_BASE_URL?.includes("sandbox")
        ? "test"
        : "production",
      raw: ligdi.data,
    });
  } catch (error) {
    console.error("Erreur balance:", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});

/* =========================
   CALLBACK PAYMENT
========================= */

app.post("/callback-ligdicash", async (req, res) => {
  try {
    const payload = req.body || {};

    // 1. Extraire transaction_id (gère tous les formats LigdiCash)
    let transactionId = null;
    if (Array.isArray(payload.custom_data)) {
      const item = payload.custom_data.find(
        (i) => i.keyof_customdata === "transaction_id"
      );
      transactionId = item?.valueof_customdata || null;
    }
    transactionId =
      transactionId ||
      payload?.custom_data?.transaction_id ||
      payload?.external_id ||
      payload?.externe_id ||
      payload?.transaction_id ||
      null;

    const rawStatus = payload?.status || payload?.statut || null;
    const responseCode = payload?.response_code || null;

    // 2. Logger le callback (best effort)
    let callbackLogId = null;
    try {
      const { data: log } = await supabase
        .from("ligdicash_callbacks")
        .insert({
          callback_type: "payment",
          http_method: req.method,
          source_ip: req.ip,
          raw_body: JSON.stringify(payload).substring(0, 5000),
          parsed_data: payload,
          transaction_id: transactionId,
          status: rawStatus,
          response_code: responseCode,
        })
        .select("id")
        .single();
      callbackLogId = log?.id || null;
    } catch (e) {
      console.error("Log insert failed:", e);
    }

    if (!transactionId) {
      return res.status(200).json({ success: true, warning: "no transaction_id" });
    }

    // 3. Récupérer le paiement
    const { data: paiement, error: fetchErr } = await supabase
      .from("paiements")
      .select("id, statut, ligdicash_token, tarif_id, hotspot_id, montant")
      .eq("custom_transaction_id", transactionId)
      .single();

    if (fetchErr || !paiement) {
      if (callbackLogId) {
        await supabase
          .from("ligdicash_callbacks")
          .update({ processing_result: "not_found", error_message: "Paiement introuvable" })
          .eq("id", callbackLogId);
      }
      return res.status(200).json({ success: true, warning: "paiement not found" });
    }

    // 4. Idempotence : déjà complété ?
    if (paiement.statut === "completed") {
      if (callbackLogId) {
        await supabase
          .from("ligdicash_callbacks")
          .update({ paiement_id: paiement.id, processing_result: "duplicate" })
          .eq("id", callbackLogId);
      }
      return res.status(200).json({ success: true, already_processed: true });
    }

    // 5. Vérification serveur-à-serveur auprès de LigdiCash (anti-spoofing)
    let verified = null;
    if (paiement.ligdicash_token) {
      const verify = await ligdicashFetch(
        `/pay/v01/redirect/checkout-invoice/confirm/?invoiceToken=${paiement.ligdicash_token}`,
        { method: "GET" }
      );
      if (verify.ok) verified = verify.data;
    }

    const isCompleted =
      (verified?.response_code === "00" && verified?.status === "completed") ||
      rawStatus === "completed" ||
      responseCode === "00";

    const isFailed =
      verified?.status === "nocompleted" ||
      rawStatus === "failed" ||
      rawStatus === "nocompleted";

    // 6. Mise à jour + attribution ticket
    if (isCompleted) {
      // Attribuer un ticket disponible directement (sans sell_ticket qui exige auth.uid())
      let ticketId = null;
      if (paiement.tarif_id && paiement.hotspot_id) {
        const { data: tarif } = await supabase
          .from("tarifs")
          .select("profil_mikrotik")
          .eq("id", paiement.tarif_id)
          .single();

        if (tarif?.profil_mikrotik) {
          const { data: ticket } = await supabase
            .from("tickets")
            .select("id")
            .eq("statut", "disponible")
            .eq("hotspot_id", paiement.hotspot_id)
            .eq("profil", tarif.profil_mikrotik)
            .order("imported_at", { ascending: true })
            .limit(1)
            .maybeSingle();

          if (ticket?.id) {
            await supabase
              .from("tickets")
              .update({
                statut: "vendu",
                sold_at: new Date().toISOString(),
                tarif_id: paiement.tarif_id,
              })
              .eq("id", ticket.id);
            ticketId = ticket.id;

            // Créer la vente
            const { data: hotspot } = await supabase
              .from("hotspots")
              .select("user_id")
              .eq("id", paiement.hotspot_id)
              .single();

            if (hotspot?.user_id) {
              await supabase.from("ventes").insert({
                ticket_id: ticket.id,
                tarif_id: paiement.tarif_id,
                vendeur_id: hotspot.user_id,
                montant: paiement.montant,
              });
            }
          }
        }
      }

      await supabase
        .from("paiements")
        .update({
          statut: "completed",
          ticket_id: ticketId,
          ligdicash_transaction_id:
            verified?.transaction_id || payload.transaction_id || null,
          telephone: verified?.customer || payload.customer || payload.telephone || null,
        })
        .eq("id", paiement.id);

      if (callbackLogId) {
        await supabase
          .from("ligdicash_callbacks")
          .update({
            paiement_id: paiement.id,
            processing_result: ticketId ? "success" : "success_no_ticket",
            status: "completed",
          })
          .eq("id", callbackLogId);
      }

      return res.status(200).json({ success: true, status: "completed", ticket_id: ticketId });
    }

    // 7. Échec ou pending
    const newStatus = isFailed ? "failed" : "pending";
    await supabase
      .from("paiements")
      .update({ statut: newStatus })
      .eq("id", paiement.id);

    if (callbackLogId) {
      await supabase
        .from("ligdicash_callbacks")
        .update({
          paiement_id: paiement.id,
          processing_result: "success",
          status: newStatus,
        })
        .eq("id", callbackLogId);
    }

    return res.status(200).json({ success: true, status: newStatus });
  } catch (error) {
    console.error("Erreur callback-ligdicash:", error);
    return res.status(200).json({
      success: true,
      warning: "Erreur interne, 200 envoyé pour éviter les retries",
    });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend BekaWiFi lancé sur le port ${PORT}`);
});
