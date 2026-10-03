import { Router, type IRouter } from "express";
import { GetFeaturedRecommendationsResponse } from "@workspace/api-zod";
import { featuredRecommendations } from "../services/eco-travel";

const router: IRouter = Router();

router.get("/recommendations/featured", (_req, res) => {
  res.json(GetFeaturedRecommendationsResponse.parse(featuredRecommendations));
});

export default router;
