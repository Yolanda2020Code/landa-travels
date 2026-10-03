import { Router, type IRouter } from "express";
import healthRouter from "./health";
import assistantRouter from "./assistant";
import recommendationsRouter from "./recommendations";
import travellerRouter from "./traveller";
import adminRouter from "./admin";
import recruitmentRouter from "./recruitment";
import advisorRouter from "./advisor";
import travelContextRouter from "./travel-context";

const router: IRouter = Router();

router.use(healthRouter);
router.use(assistantRouter);
router.use(recommendationsRouter);
router.use(travellerRouter);
router.use(adminRouter);
router.use(recruitmentRouter);
router.use(advisorRouter);
router.use(travelContextRouter);

export default router;
