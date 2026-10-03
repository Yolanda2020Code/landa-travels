"""Rasa-native extraction after DIET, retaining NLU and form ownership."""

from typing import Any, Dict, List, Text

from rasa.engine.graph import ExecutionContext, GraphComponent
from rasa.engine.recipes.default_recipe import DefaultV1Recipe
from rasa.engine.storage.resource import Resource
from rasa.engine.storage.storage import ModelStorage
from rasa.shared.nlu.constants import ENTITIES, TEXT
from rasa.shared.nlu.training_data.message import Message

from travel_nlu.entity_rules import extract_travel_entities, merge_travel_entities


@DefaultV1Recipe.register(DefaultV1Recipe.ComponentType.ENTITY_EXTRACTOR, is_trainable=False)
class TravelEntityExtractor(GraphComponent):
    """Resolve explicit travel spans; retain learned extraction elsewhere."""

    @classmethod
    def create(cls, config: Dict[Text, Any], model_storage: ModelStorage,
               resource: Resource, execution_context: ExecutionContext):
        return cls()

    def process(self, messages: List[Message]) -> List[Message]:
        for message in messages:
            text = message.get(TEXT, "")
            doc = message.get("text_spacy_doc")
            places = [(e.start_char, e.end_char) for e in doc.ents if e.label_ in {"GPE", "LOC", "FAC"}] if doc is not None else []
            # Geographic evidence is separate from trip entities. Only the
            # gateway may bind a whole-place answer to the current Rasa prompt;
            # these spans must not populate arbitrary slots on rejected turns.
            message.set("geographic_spans", [
                {"start": start, "end": end, "value": text[start:end]}
                for start, end in places
            ], add_to_output=True)
            dates = [(e.start_char, e.end_char) for e in doc.ents if e.label_ == "DATE"] if doc is not None else []
            extracted = extract_travel_entities(text, places, dates)
            for entity in extracted:
                entity["extractor"] = self.__class__.__name__
            result = merge_travel_entities(
                text, message.get(ENTITIES, []), extracted, message.get("intent", {}).get("name"))
            message.set(ENTITIES, result, add_to_output=True)
        return messages