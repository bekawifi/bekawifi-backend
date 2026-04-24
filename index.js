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
    const payload = req.body;

    const transactionId =
      payload?.custom_data?.transaction_id ||
      payload?.custom_data?.valueof_customdata ||
      payload?.externe_id ||
      payload?.external_id ||
      payload?.transaction_id;

    const status =
      payload?.status ||
      payload?.statut ||
      payload?.response_status ||
      payload?.response_code;

    const { data: callbackLog } = await supabase
      .from("ligdicash_callbacks")
      .insert({
        raw_body: payload,
        parsed_data: payload,
        source_ip: req.ip,
        http_method: req.method,
        callback_type: "payment",
      })
      .select()
      .single();

    if (!transactionId) {
      return res.status(200).json({ success: true });
    }

    const { data: paiement } = await supabase
      .from("paiements")
      .select("*")
      .eq("custom_transaction_id", transactionId)
      .single();

    if (!paiement) {
      return res.status(200).json({ success: true });
    }

    if (status === "completed" || payload.response_code === "00") {
      let ticketId = null;

      const { data: sellResult, error: sellError } = await supabase.rpc(
        "sell_ticket",
        {
          _tarif_id: paiement.tarif_id,
          _vendeur_id: paiement.vendeur_id || null,
          _profil_mikrotik: paiement.profil_mikrotik || null,
          _montant: paiement.montant,
          _hotspot_id: paiement.hotspot_id,
        }
      );

      if (!sellError && sellResult) {
        ticketId = Array.isArray(sellResult)
          ? sellResult[0]?.ticket_id || sellResult[0]?.id
          : sellResult.ticket_id || sellResult.id;
      }

      await supabase
        .from("paiements")
        .update({
          statut: "completed",
          telephone: payload.customer || payload.telephone || null,
          ticket_id: ticketId,
        })
        .eq("id", paiement.id);
    }

    if (status === "failed") {
      await supabase
        .from("paiements")
        .update({ statut: "failed" })
        .eq("id", paiement.id);
    }

    if (callbackLog?.id) {
      await supabase
        .from("ligdicash_callbacks")
        .update({
          paiement_id: paiement.id,
          processing_result: { success: true, transactionId, status },
        })
        .eq("id", callbackLog.id);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Erreur callback-ligdicash:", error);

    return res.status(200).json({
      success: true,
      warning: "Erreur interne mais réponse 200 envoyée à LigdiCash",
    });
  }
});

/* =========================
   CALLBACK PAYOUT
========================= */

app.post("/callback-payout", async (req, res) => {
  try {
    const payload = req.body;

    const payoutToken =
      payload.token ||
      payload.payout_token ||
      payload.transaction_token ||
      payload.transaction_id;

    const status =
      payload.status ||
      payload.statut ||
      payload.response_status ||
      payload.response_code;

    await supabase.from("ligdicash_callbacks").insert({
      raw_body: payload,
      parsed_data: payload,
      source_ip: req.ip,
      http_method: req.method,
      callback_type: "payout",
    });

    if (!payoutToken) {
      return res.status(200).json({ success: true });
    }

    const { data: retrait } = await supabase
      .from("retraits")
      .select("*")
      .eq("payout_token", payoutToken)
      .single();

    if (!retrait) {
      return res.status(200).json({ success: true });
    }

    if (status === "success" || status === "completed" || payload.response_code === "00") {
      await supabase
        .from("retraits")
        .update({
          statut: "valide",
          payout_status: "completed",
          validated_at: new Date().toISOString(),
        })
        .eq("id", retrait.id);
    }

    if (status === "failed") {
      await supabase
        .from("retraits")
        .update({
          statut: "refuse",
          payout_status: "failed",
          motif_refus: payload.response_text || "Payout échoué",
        })
        .eq("id", retrait.id);
    }

    await supabase
      .from("payout_attempts")
      .update({
        status,
        response_payload: payload,
      })
      .eq("retrait_id", retrait.id);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Erreur callback-payout:", error);

    return res.status(200).json({
      success: true,
      warning: "Erreur interne mais réponse 200 envoyée à LigdiCash",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
