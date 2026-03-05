export default async function userAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Authorization token missing",
      });
    }

    // ✅ Call TalkifyAuth backend
    const verifyRes = await fetch("http://localhost:5000/auth/me", {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
    });

    // ❗ Body को सिर्फ ONCE read करो
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok || verifyData.ok !== true) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    // ✅ Attach user
    req.user = verifyData.user;

    next();
  } catch (err) {
    console.error("USER AUTH MIDDLEWARE ERROR:", err.message);

    return res.status(500).json({
      success: false,
      message: "Authentication service unavailable",
    });
  }
}
